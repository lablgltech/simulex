"""Роутер чата для этапа 3.

Контракт эндпоинтов максимально близок к прототипу v0.5beta:
- POST /api/chat/session/{session_id}/clause/{clause_id}/activate
- POST /api/chat/session/{session_id}/clause/{clause_id}/message
- GET  /api/chat/session/{session_id}/history
"""

import logging
import sys
import time
import traceback
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any

from api_errors import client_500_detail_from_exception, client_502_detail_from_message
from dev_mirror_log import append_mirror
from routers.auth import get_current_user
from services import chat_service
from services.negotiation_access import user_owns_negotiation_session
from services.negotiation_session_service import set_ai_mode, reset_negotiation_contract_to_initial

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat"])


def _require_negotiation_owner(session_id: int, current_user: Dict[str, Any]) -> None:
    if not user_owns_negotiation_session(session_id, int(current_user["id"])):
        raise HTTPException(status_code=404, detail="Сессия не найдена")


def _echo_terminal(line: str) -> None:
    """stderr терминала Cursor + зеркало в файл."""
    try:
        print(line, file=sys.stderr, flush=True)
    except OSError:
        pass
    append_mirror(line)


class ActivateChatRequest(BaseModel):
    action: str  # 'reject', 'change', 'discuss', 'insist'


class SendMessageRequest(BaseModel):
    action: Optional[str] = None
    choiceIndex: Optional[int] = None
    reasonIndex: Optional[int] = None
    justificationText: Optional[str] = None
    formulationText: Optional[str] = None
    explanationText: Optional[str] = None
    newClauseText: Optional[str] = None


class SetAiModeRequest(BaseModel):
  enabled: bool


@router.post("/session/{session_id}/clause/{clause_id}/activate")
async def activate_chat_endpoint(
    session_id: int,
    clause_id: str,
    request: ActivateChatRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Активация чата для пункта договора.
    session_id здесь — negotiation_session_id.
    """
    try:
        _require_negotiation_owner(session_id, current_user)
        _echo_terminal(
            f"[CHAT] activate session={session_id} clause={clause_id} action={request.action}"
        )
        return chat_service.activate_chat(session_id, clause_id, request.action)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("chat/activate error: %s", e)
        msg = str(e)
        if "502" in msg or "Bad Gateway" in msg:
            raise HTTPException(status_code=502, detail=client_502_detail_from_message(msg))
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/session/{session_id}/clause/{clause_id}/message")
async def send_message_endpoint(
    session_id: int,
    clause_id: str,
    request: SendMessageRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Отправка сообщения/выбора игрока.
    session_id здесь — negotiation_session_id.
    """
    try:
        _require_negotiation_owner(session_id, current_user)
        def _str(v):
            return (v or "").strip() if v is not None else ""

        player_input: Dict[str, Any] = {
            "action": request.action or "change",
            "choiceIndex": request.choiceIndex,
            "reasonIndex": request.reasonIndex,
            "justificationText": _str(request.justificationText),
            "formulationText": _str(request.formulationText),
            "explanationText": _str(request.explanationText),
            "newClauseText": _str(request.newClauseText),
        }
        _in = (
            "[CHAT] >>> session=%s clause=%s action=%s form='%s' expl='%s'"
            % (
                session_id,
                clause_id,
                player_input["action"],
                player_input["formulationText"][:80],
                player_input["explanationText"][:80],
            )
        )
        logger.info(_in)
        _echo_terminal(_in)
        _handler_t0 = time.perf_counter()
        result = chat_service.send_message(session_id, clause_id, player_input)
        _handler_ms = (time.perf_counter() - _handler_t0) * 1000.0
        _echo_terminal(
            f"[CHAT_HANDLER] session={session_id} clause={clause_id} "
            f"total_wall_ms={_handler_ms:.0f} (полный цикл обработки POST /message на сервере)"
        )
        _br = result.get("botResponse", {})
        _out = (
            "[CHAT] <<< session=%s clause=%s agrees=%s score=%s complete=%s outcome=%s msg='%s'"
            % (
                session_id,
                clause_id,
                _br.get("agrees"),
                _br.get("convincingScore"),
                result.get("chatComplete"),
                result.get("outcomeType"),
                (_br.get("message") or "")[:320],
            )
        )
        logger.info(_out)
        _echo_terminal(_out)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OSError as e:
        errno_val = getattr(e, "errno", None)
        _debug_path = Path(__file__).resolve().parent.parent / "errno22_debug.txt"
        try:
            with _debug_path.open("w", encoding="utf-8") as f:
                f.write(f"OSError errno={errno_val} winerror={getattr(e, 'winerror', None)}\n{e}\n\n")
                traceback.print_exc(file=f)
        except Exception:
            pass
        # Любой OSError на Windows — возвращаем понятное сообщение (Errno 22 и др.)
        if sys.platform == "win32" or errno_val in (22, 10022):
            raise HTTPException(
                status_code=500,
                detail="Внутренняя ошибка при обработке сообщения. Попробуйте ещё раз или перезагрузите страницу.",
            )
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
    except NameError as e:
        # name 'justification_text' is not defined — пишем traceback в файл для отладки
        tb_lines = traceback.format_exc()
        logger.exception("chat/message NameError: %s\n%s", e, tb_lines)
        # Файл в корне проекта (папка simulex), чтобы легко найти
        _nameerror_path = Path(__file__).resolve().parent.parent.parent / "nameerror_traceback.txt"
        try:
            with _nameerror_path.open("w", encoding="utf-8") as _f:
                _f.write(f"NameError: {e}\n\n")
                _f.write(tb_lines)
        except Exception as _write_err:
            logger.warning("Не удалось записать traceback в файл: %s", _write_err)
        raise HTTPException(
            status_code=500,
            detail=client_500_detail_from_exception(e),
        )
    except Exception as e:
        # Проверяем причину: OSError 22 может быть в __cause__ (raise ... from e)
        errno22 = False
        if isinstance(e, OSError) and getattr(e, "errno", None) in (22, 10022):
            errno22 = True
        cause = getattr(e, "__cause__", None)
        if cause and isinstance(cause, OSError) and getattr(cause, "errno", None) in (22, 10022):
            errno22 = True
        if errno22 or ("Errno 22" in str(e) and "Invalid argument" in str(e)):
            _debug_path = Path(__file__).resolve().parent.parent / "errno22_debug.txt"
            try:
                with _debug_path.open("w", encoding="utf-8") as f:
                    f.write(f"Exception: {type(e).__name__}: {e}\n\n")
                    traceback.print_exc(file=f)
            except Exception:
                pass
            raise HTTPException(
                status_code=500,
                detail="Внутренняя ошибка при обработке сообщения. Попробуйте ещё раз или перезагрузите страницу.",
            )
        try:
            logger.exception("chat/message error: %s", e)
        except OSError:
            pass
        msg = str(e)
        if "502" in msg or "Bad Gateway" in msg:
            raise HTTPException(status_code=502, detail=client_502_detail_from_message(msg))
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/session/{session_id}/history")
async def get_chat_history_endpoint(
    session_id: int, current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Получить историю чата для negotiation_session.
    """
    try:
        _require_negotiation_owner(session_id, current_user)
        return chat_service.get_chat_history(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("chat/history error: %s", e)
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/session/{session_id}/ai-mode")
async def set_ai_mode_endpoint(
    session_id: int,
    request: SetAiModeRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Включить / выключить ИИ‑режим для negotiation_session.
    """
    try:
        _require_negotiation_owner(session_id, current_user)
        return set_ai_mode(session_id, request.enabled)
    except Exception as e:
        logger.exception("chat/ai-mode error: %s", e)
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/session/{session_id}/reset-progress")
async def reset_negotiation_progress_endpoint(
    session_id: int, current_user: Dict[str, Any] = Depends(get_current_user)
):
    """
    Сбросить подстановки в договоре, статусы пунктов и историю чата к исходному состоянию кейса.
    Режим ИИ (history_json.mode / ai.enabled) не меняется — в отличие от переключения ai-mode.
    """
    try:
        _require_negotiation_owner(session_id, current_user)
        reset_negotiation_contract_to_initial(session_id)
        return {"ok": True}
    except Exception as e:
        logger.exception("chat/reset-progress error: %s", e)
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))

