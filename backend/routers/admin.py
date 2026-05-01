"""Роутер админ-панели: кейсы (CRUD), файлы ресурсов кейса, генерация кейсов, пользователи, RAG-статистика."""
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, UploadFile, File, Form
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from api_errors import client_500_detail_from_exception
from config import DATA_DIR

logger = logging.getLogger(__name__)
from db import get_connection
from routers.auth import get_current_user, get_current_user_optional
from services.auth_service import (
    create_group,
    create_user,
    delete_user,
    get_user_by_id,
    group_exists,
    list_groups,
    list_users_for_panel,
    participant_user_ids_visible_to_viewer,
)
import json
from services.case_service import (
    build_case_dependency_report,
    copy_case_skeleton,
    create_case,
    force_reseed_cases_from_fs,
    get_all_cases,
    get_case,
    get_case_titles_by_codes,
    materialize_case_resources,
    read_case_file,
    save_case_to_fs,
    write_case_file,
    write_case_methodology_documentation,
)
from services.redis_client import redis_release_reseed_lock, redis_try_lock_reseed
from services.game_session_service import get_game_session
from services.document_service import get_contract_md_resolution_debug
from services.ai_model_config import (
    load_ai_model_config,
    save_ai_model_config,
    get_available_models_for_ui,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])
security = HTTPBearer(auto_error=False)


def _admin_key() -> Optional[str]:
    return os.environ.get("ADMIN_API_KEY", "").strip() or None


async def require_admin(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Optional[Dict[str, Any]]:
    """
    Проверка доступа: JWT с ролью admin/superuser ИЛИ X-Admin-Key.
    Возвращает текущего пользователя (если по JWT) или None (если по ключу).
    """
    user = get_current_user_optional(request, credentials)
    if user and user.get("role") in ("admin", "superuser"):
        logger.info(
            "admin request user_id=%s role=%s path=%s",
            user.get("id"),
            user.get("role"),
            request.url.path,
        )
        return user
    key = _admin_key()
    if not key:
        return None
    header_key = request.headers.get("X-Admin-Key", "").strip()
    if header_key == key:
        logger.info("admin access via X-Admin-Key (service key)")
        return None
    raise HTTPException(status_code=401, detail="Требуется авторизация (JWT или ключ админ-API)")


async def require_superuser(
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """Только суперюзер (JWT, роль superuser)."""
    if current_user.get("role") != "superuser":
        raise HTTPException(status_code=403, detail="Доступ только для суперюзера")
    return current_user


class AiModelConfigBody(BaseModel):
    stage1_model: Optional[str] = None
    stage3_model: Optional[str] = None
    tutor_model: Optional[str] = None
    report_model: Optional[str] = None


@router.get("/ai-config", dependencies=[Depends(require_admin)])
async def admin_get_ai_config() -> Dict[str, Any]:
    """
    Текущая конфигурация моделей ИИ для потребителей:
    - stage1_model: этап 1 (инициатор)
    - stage3_model: этап 3 (ИИ-контрагент / оценка)
    - tutor_model: ИИ-тьютор
    - report_model: нарратив отчёта, summary и soft-skills сессии
    """
    cfg = load_ai_model_config()
    models = get_available_models_for_ui()
    return {
        "stage1_model": cfg.get("stage1_model"),
        "stage3_model": cfg.get("stage3_model"),
        "tutor_model": cfg.get("tutor_model"),
        "report_model": cfg.get("report_model"),
        "available_models": models["all"],
        "popular_models": models["popular"],
    }


@router.put("/ai-config", dependencies=[Depends(require_admin)])
async def admin_put_ai_config(body: AiModelConfigBody) -> Dict[str, Any]:
    """
    Обновить конфигурацию моделей ИИ.
    Любое из полей можно опустить — тогда оно останется без изменений.
    """
    try:
        new_cfg = save_ai_model_config(
            {
                k: v
                for k, v in {
                    "stage1_model": body.stage1_model,
                    "stage3_model": body.stage3_model,
                    "tutor_model": body.tutor_model,
                    "report_model": body.report_model,
                }.items()
                if v is not None
            }
        )
        models = get_available_models_for_ui()
        return {
            "ok": True,
            "stage1_model": new_cfg.get("stage1_model"),
            "stage3_model": new_cfg.get("stage3_model"),
            "tutor_model": new_cfg.get("tutor_model"),
            "report_model": new_cfg.get("report_model"),
            "available_models": models["all"],
            "popular_models": models["popular"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Не удалось сохранить конфиг ИИ: {e}") from e


@router.get("/debug/contract-md", dependencies=[Depends(require_admin)])
async def admin_debug_contract_md(code: str = Query("dogovor_PO", description="Код договора в таблице contract")) -> Dict[str, Any]:
    """
    Что реально читает бэкенд для Markdown договора этапа 3: BASE_DIR, пути из БД, абсолютный путь к файлу, строка 1.1.1.
    Вызывать на проде после споров «файл на диске правильный, а в UI нет».
    """
    try:
        out = get_contract_md_resolution_debug(code.strip() or "dogovor_PO")
        out["hint"] = (
            "Сравните primary_absolute с тем путём, который вы открываете в редакторе на сервере. "
            "Должны совпадать. BASE_DIR — родитель каталога backend (обычно /opt/simulex)."
        )
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e)) from e


@router.post("/reseed-cases", dependencies=[Depends(require_admin)])
async def admin_reseed_cases() -> Dict[str, Any]:
    """Принудительно перезагрузить кейсы из JSON-файлов в БД (без перезапуска сервера)."""
    if not redis_try_lock_reseed():
        raise HTTPException(
            status_code=409,
            detail="Синхронизация кейсов уже выполняется другим запросом. Повторите позже.",
        )
    try:
        force_reseed_cases_from_fs(DATA_DIR, fail_on_contract_seed_errors=True)
        return {"ok": True, "message": "Кейсы синхронизированы с файлами. Обновите страницу в браузере."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
    finally:
        redis_release_reseed_lock()


@router.get("/cases", dependencies=[Depends(require_admin)])
async def admin_list_cases() -> List[Dict[str, Any]]:
    """Список всех кейсов (в т.ч. draft/archived)."""
    try:
        return get_all_cases(DATA_DIR, include_all_statuses=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/cases/{case_id}", dependencies=[Depends(require_admin)])
async def admin_get_case(case_id: str) -> Dict[str, Any]:
    """Полный кейс с контентом из файлов (актуальные JSON/md без ожидания sync в БД)."""
    try:
        data = get_case(DATA_DIR, case_id, source="filesystem")
        # Нормализуем запрошенный id так же, как в get_case
        raw = str(case_id).strip().replace("case-", "")
        want_code = "case-001" if raw in ("001", "") else (case_id if str(case_id).startswith("case-") else f"case-{case_id}")
        if (data.get("id") or "").strip() != want_code:
            raise HTTPException(status_code=404, detail=f"Кейс {case_id} не найден")
        return data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/cases/{case_id}/dependencies", dependencies=[Depends(require_admin)])
async def admin_case_dependencies(case_id: str) -> Dict[str, Any]:
    """
    Карта файловых зависимостей кейса для редактора (пути из JSON, обложка, конвенции stage-1/4).
    """
    try:
        data = get_case(DATA_DIR, case_id, source="filesystem")
        raw = str(case_id).strip().replace("case-", "")
        want_code = "case-001" if raw in ("001", "") else (case_id if str(case_id).startswith("case-") else f"case-{case_id}")
        if (data.get("id") or "").strip() != want_code:
            raise HTTPException(status_code=404, detail=f"Кейс {case_id} не найден")
        return build_case_dependency_report(DATA_DIR, data)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.put("/cases/{case_id}", dependencies=[Depends(require_admin)])
async def admin_put_case(case_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Сохранить кейс в файл и БД. Тело — JSON кейса (без обёртки case)."""
    if (body.get("id") or "").strip() != case_id.strip():
        raise HTTPException(status_code=400, detail="id в теле не совпадает с case_id в URL")
    try:
        save_case_to_fs(DATA_DIR, body)
        return {"ok": True, "id": case_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/cases", dependencies=[Depends(require_admin)])
async def admin_post_case(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Создать новый кейс.
    Тело: либо минимальное { title?, description?, stages? }, либо полный черновик кейса (из генератора).
    При полном черновике (id=case-draft или есть intro/outro/lexic_initial) генерируется новый id и кейс сохраняется как есть.
    """
    stages = body.get("stages")
    if stages is not None and not isinstance(stages, list):
        raise HTTPException(status_code=400, detail="stages должен быть массивом")

    is_full_draft = (
        body.get("id") == "case-draft"
        or "intro" in body
        or "outro" in body
        or "lexic_initial" in body
        or "contract" in body
        or "crisis" in body
    )
    if is_full_draft and stages:
        try:
            new_case = create_case(DATA_DIR, title=(body.get("title") or "Черновик").strip() or "Черновик", description=(body.get("description") or "").strip(), stages=[])
            new_id = new_case["id"]
            case_data = {**body, "id": new_id}
            resource_tpl = (body.get("resource_template_case_id") or "").strip()
            if resource_tpl:
                # create_case уже создал data/cases/<id>/ — без overwrite копирование не выполнилось бы
                copy_case_skeleton(DATA_DIR, resource_tpl, new_id, overwrite=True)
            case_data = materialize_case_resources(DATA_DIR, new_id, case_data)
            save_case_to_fs(DATA_DIR, case_data)
            methodology_doc: Optional[str] = None
            try:
                methodology_doc = write_case_methodology_documentation(DATA_DIR, case_data)
            except Exception as e:
                print(f"⚠️ write_case_methodology_documentation: {e}")
            out: Dict[str, Any] = {"id": new_id, "case": get_case(DATA_DIR, new_id)}
            if methodology_doc:
                out["methodology_documentation"] = methodology_doc
            return out
        except Exception as e:
            raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))

    title = (body.get("title") or "Новый кейс").strip() or "Новый кейс"
    description = (body.get("description") or "").strip()
    try:
        case_data = create_case(DATA_DIR, title=title, description=description, stages=stages or [])
        return {"id": case_data["id"], "case": case_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/cases/{case_id}/file", dependencies=[Depends(require_admin)])
async def admin_get_case_file(
    case_id: str,
    path: str = Query(..., description="Путь относительно data/cases/case-{id}/"),
) -> Dict[str, Any]:
    """Содержимое файла ресурса кейса (например stage-2/risk_matrix.json)."""
    if not path or ".." in path:
        raise HTTPException(status_code=400, detail="Недопустимый path")
    try:
        content = read_case_file(DATA_DIR, case_id, path)
        return {"path": path, "content": content}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Файл не найден: {path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.put("/cases/{case_id}/file", dependencies=[Depends(require_admin)])
async def admin_put_case_file(case_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Записать файл ресурса кейса. Тело: { path, content }."""
    path = (body.get("path") or "").strip()
    content = body.get("content")
    if not path or ".." in path:
        raise HTTPException(status_code=400, detail="Недопустимый path")
    if content is None:
        content = ""
    if not isinstance(content, str):
        content = str(content)
    try:
        write_case_file(DATA_DIR, case_id, path, content)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/dashboard")
async def admin_dashboard(
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Дашборд для методиста: агрегированная статистика по сессиям.
    Для роли admin — только сессии участников своей группы.
    """
    try:
        allowed = participant_user_ids_visible_to_viewer(current_user)
        sess_where = ""
        sess_params: List[Any] = []
        if allowed is not None:
            sess_where = " AND user_id = ANY(%s)"
            sess_params = [allowed]
        gs_where = ""
        gs_params: List[Any] = []
        if allowed is not None:
            gs_where = " AND gs.user_id = ANY(%s)"
            gs_params = [allowed]

        with get_connection() as conn:
            with conn.cursor() as cur:
                # 1) Общая статистика по сессиям
                cur.execute("SELECT COUNT(*) FROM game_session WHERE 1=1" + sess_where, sess_params)
                total_sessions_row = cur.fetchone()
                total_sessions = int(total_sessions_row[0]) if total_sessions_row else 0

                cur.execute(
                    """
                    SELECT COUNT(*) FROM session_summary ss
                    INNER JOIN game_session gs ON gs.external_id = ss.session_external_id
                    WHERE 1=1
                    """
                    + gs_where,
                    gs_params,
                )
                completed_row = cur.fetchone()
                sessions_with_summary = int(completed_row[0]) if completed_row else 0

                cur.execute(
                    "SELECT COUNT(DISTINCT case_code) FROM game_session WHERE 1=1" + sess_where,
                    sess_params,
                )
                cases_row = cur.fetchone()
                distinct_cases = int(cases_row[0]) if cases_row else 0

                cur.execute(
                    "SELECT COUNT(*) FROM game_session WHERE created_at >= NOW() - INTERVAL '7 days'"
                    + sess_where,
                    sess_params,
                )
                last7_row = cur.fetchone()
                sessions_last_7d = int(last7_row[0]) if last7_row else 0

                cur.execute(
                    "SELECT COUNT(*) FROM game_session WHERE created_at >= NOW() - INTERVAL '30 days'"
                    + sess_where,
                    sess_params,
                )
                last30_row = cur.fetchone()
                sessions_last_30d = int(last30_row[0]) if last30_row else 0

                # 2) Распределение LEXIC по всем сессиям
                cur.execute(
                    """
                    SELECT
                      COUNT(*) AS total,
                      AVG(COALESCE((payload_json->'lexic'->>'L')::int, 0)) AS avg_L,
                      AVG(COALESCE((payload_json->'lexic'->>'E')::int, 0)) AS avg_E,
                      AVG(COALESCE((payload_json->'lexic'->>'X')::int, 0)) AS avg_X,
                      AVG(COALESCE((payload_json->'lexic'->>'I')::int, 0)) AS avg_I,
                      AVG(COALESCE((payload_json->'lexic'->>'C')::int, 0)) AS avg_C
                    FROM game_session
                    WHERE payload_json ? 'lexic'
                    """
                    + sess_where,
                    sess_params,
                )
                row = cur.fetchone()
                lexic_stats = {
                    "total_sessions_with_lexic": int(row[0]) if row and row[0] is not None else 0,
                    "avg_L": float(row[1]) if row and row[1] is not None else None,
                    "avg_E": float(row[2]) if row and row[2] is not None else None,
                    "avg_X": float(row[3]) if row and row[3] is not None else None,
                    "avg_I": float(row[4]) if row and row[4] is not None else None,
                    "avg_C": float(row[5]) if row and row[5] is not None else None,
                }

                # 3) Сессии по кейсам
                cur.execute(
                    """
                    SELECT
                      case_code,
                      COUNT(*) AS total_sessions,
                      AVG(
                        (
                          COALESCE((payload_json->'lexic'->>'L')::int, 0) +
                          COALESCE((payload_json->'lexic'->>'E')::int, 0) +
                          COALESCE((payload_json->'lexic'->>'X')::int, 0) +
                          COALESCE((payload_json->'lexic'->>'I')::int, 0) +
                          COALESCE((payload_json->'lexic'->>'C')::int, 0)
                        ) / 5.0
                      ) AS avg_lexic
                    FROM game_session
                    WHERE 1=1
                    """
                    + sess_where
                    + """
                    GROUP BY case_code
                    ORDER BY total_sessions DESC
                    LIMIT 10
                    """,
                    sess_params,
                )
                sessions_by_case: List[Dict[str, Any]] = []
                for case_code, count, avg_lexic in cur.fetchall():
                    sessions_by_case.append(
                        {
                            "case_code": case_code,
                            "total_sessions": int(count),
                            "avg_lexic": float(avg_lexic) if avg_lexic is not None else None,
                        }
                    )

                # 4) Soft-skills (session_soft_skills)
                if allowed is None:
                    cur.execute(
                        """
                        SELECT
                          COUNT(*) AS total_profiles,
                          AVG(COALESCE((profile_json->>'argumentation_level')::float, 0)) AS avg_argumentation_level,
                          AVG(COALESCE((profile_json->>'risk_aversion')::float, 0)) AS avg_risk_aversion,
                          AVG(COALESCE((profile_json->>'self_reflection')::float, 0)) AS avg_self_reflection
                        FROM session_soft_skills
                        """
                    )
                else:
                    cur.execute(
                        """
                        SELECT
                          COUNT(*) AS total_profiles,
                          AVG(COALESCE((sk.profile_json->>'argumentation_level')::float, 0)) AS avg_argumentation_level,
                          AVG(COALESCE((sk.profile_json->>'risk_aversion')::float, 0)) AS avg_risk_aversion,
                          AVG(COALESCE((sk.profile_json->>'self_reflection')::float, 0)) AS avg_self_reflection
                        FROM session_soft_skills sk
                        INNER JOIN game_session gs ON gs.external_id = sk.session_external_id
                        WHERE 1=1
                        """
                        + gs_where,
                        gs_params,
                    )
                row = cur.fetchone()
                soft_skills_stats = {
                    "total_profiles": int(row[0]) if row and row[0] is not None else 0,
                    "avg_argumentation_level": float(row[1]) if row and row[1] is not None else None,
                    "avg_risk_aversion": float(row[2]) if row and row[2] is not None else None,
                    "avg_self_reflection": float(row[3]) if row and row[3] is not None else None,
                    "negotiation_styles": [],
                }

                if allowed is None:
                    cur.execute(
                        """
                        SELECT
                          COALESCE(profile_json->>'negotiation_style', 'unknown') AS style,
                          COUNT(*) AS cnt
                        FROM session_soft_skills
                        GROUP BY COALESCE(profile_json->>'negotiation_style', 'unknown')
                        ORDER BY cnt DESC
                        """
                    )
                else:
                    cur.execute(
                        """
                        SELECT
                          COALESCE(sk.profile_json->>'negotiation_style', 'unknown') AS style,
                          COUNT(*) AS cnt
                        FROM session_soft_skills sk
                        INNER JOIN game_session gs ON gs.external_id = sk.session_external_id
                        WHERE 1=1
                        """
                        + gs_where
                        + """
                        GROUP BY COALESCE(sk.profile_json->>'negotiation_style', 'unknown')
                        ORDER BY cnt DESC
                        """,
                        gs_params,
                    )
                soft_styles: List[Dict[str, Any]] = []
                for style, cnt in cur.fetchall():
                    soft_styles.append({"style": style, "count": int(cnt)})
                soft_skills_stats["negotiation_styles"] = soft_styles

                # 5) Использование тьютора
                if allowed is None:
                    cur.execute("SELECT COUNT(*) FROM tutor_message_log")
                else:
                    cur.execute(
                        """
                        SELECT COUNT(*) FROM tutor_message_log t
                        INNER JOIN game_session gs ON gs.external_id = t.session_external_id
                        WHERE 1=1
                        """
                        + gs_where,
                        gs_params,
                    )
                total_msgs_row = cur.fetchone()
                total_tutor_messages = int(total_msgs_row[0]) if total_msgs_row else 0

                if allowed is None:
                    cur.execute(
                        "SELECT COUNT(DISTINCT session_external_id) FROM tutor_message_log WHERE session_external_id IS NOT NULL"
                    )
                else:
                    cur.execute(
                        """
                        SELECT COUNT(DISTINCT t.session_external_id) FROM tutor_message_log t
                        INNER JOIN game_session gs ON gs.external_id = t.session_external_id
                        WHERE t.session_external_id IS NOT NULL
                        """
                        + gs_where,
                        gs_params,
                    )
                sess_row = cur.fetchone()
                sessions_with_tutor = int(sess_row[0]) if sess_row else 0

                avg_msgs_per_session = (
                    float(total_tutor_messages) / sessions_with_tutor if sessions_with_tutor > 0 else 0.0
                )

                tutor_usage = {
                    "total_messages": total_tutor_messages,
                    "sessions_with_tutor": sessions_with_tutor,
                    "avg_messages_per_session": avg_msgs_per_session,
                }

                # 6) Завершения этапов
                if allowed is None:
                    cur.execute(
                        """
                        SELECT
                          COALESCE(stage_code, 'unknown') AS stage_code,
                          COUNT(*) AS completions
                        FROM session_action_log
                        WHERE action_type = 'stage_complete'
                        GROUP BY COALESCE(stage_code, 'unknown')
                        ORDER BY stage_code
                        """
                    )
                else:
                    cur.execute(
                        """
                        SELECT
                          COALESCE(sal.stage_code, 'unknown') AS stage_code,
                          COUNT(*) AS completions
                        FROM session_action_log sal
                        INNER JOIN game_session gs ON gs.external_id = sal.session_external_id
                        WHERE sal.action_type = 'stage_complete'
                        """
                        + gs_where
                        + """
                        GROUP BY COALESCE(sal.stage_code, 'unknown')
                        ORDER BY stage_code
                        """,
                        gs_params,
                    )
                stage_completion: List[Dict[str, Any]] = []
                for stage_code, completions in cur.fetchall():
                    stage_completion.append(
                        {"stage_code": stage_code, "completions": int(completions)}
                    )

                # 7) Последние сессии
                cur.execute(
                    """
                    SELECT
                      gs.external_id,
                      gs.case_code,
                      gs.created_at,
                      gs.updated_at,
                      CASE
                        WHEN gs.payload_json ? 'lexic' THEN
                          (
                            COALESCE((gs.payload_json->'lexic'->>'L')::int, 0) +
                            COALESCE((gs.payload_json->'lexic'->>'E')::int, 0) +
                            COALESCE((gs.payload_json->'lexic'->>'X')::int, 0) +
                            COALESCE((gs.payload_json->'lexic'->>'I')::int, 0) +
                            COALESCE((gs.payload_json->'lexic'->>'C')::int, 0)
                          ) / 5.0
                        ELSE NULL
                      END AS avg_lexic,
                      (ss.session_external_id IS NOT NULL) AS has_summary
                    FROM game_session gs
                    LEFT JOIN session_summary ss ON ss.session_external_id = gs.external_id
                    WHERE 1=1
                    """
                    + gs_where
                    + """
                    ORDER BY gs.created_at DESC
                    LIMIT 10
                    """,
                    gs_params,
                )
                recent_sessions: List[Dict[str, Any]] = []
                for external_id, case_code, created_at, updated_at, avg_lexic, has_summary in cur.fetchall():
                    recent_sessions.append(
                        {
                            "session_id": external_id,
                            "case_code": case_code,
                            "created_at": created_at.isoformat() if created_at else None,
                            "updated_at": updated_at.isoformat() if updated_at else None,
                            "avg_lexic": float(avg_lexic) if avg_lexic is not None else None,
                            "has_summary": bool(has_summary),
                        }
                    )

        completion_rate = (
            float(sessions_with_summary) / total_sessions if total_sessions > 0 else 0.0
        )

        return {
            "overall": {
                "total_sessions": total_sessions,
                "sessions_with_summary": sessions_with_summary,
                "completion_rate": completion_rate,
                "distinct_cases": distinct_cases,
                "sessions_last_7d": sessions_last_7d,
                "sessions_last_30d": sessions_last_30d,
            },
            "lexic": lexic_stats,
            "sessions_by_case": sessions_by_case,
            "soft_skills": soft_skills_stats,
            "tutor_usage": tutor_usage,
            "stage_completion": stage_completion,
            "recent_sessions": recent_sessions,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/reports")
async def admin_reports(
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Отчёты пользователей с ролью user: сессии сгруппированы по пользователю.
    Суперюзер — все user; админ — только участники своей группы.
    """
    allowed = participant_user_ids_visible_to_viewer(current_user)
    with get_connection() as conn:
        with conn.cursor() as cur:
            if allowed is None:
                cur.execute(
                    """
                    SELECT u.id, u.username
                    FROM "user" u
                    WHERE u.role = 'user'
                    ORDER BY u.username
                    """
                )
                user_rows = cur.fetchall()
            elif not allowed:
                user_rows = []
            else:
                cur.execute(
                    """
                    SELECT u.id, u.username
                    FROM "user" u
                    WHERE u.role = 'user' AND u.id = ANY(%s)
                    ORDER BY u.username
                    """,
                    (allowed,),
                )
                user_rows = cur.fetchall()
    by_user: List[Dict[str, Any]] = []
    for uid, username in user_rows:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT gs.external_id, gs.case_code, gs.payload_json, gs.created_at
                    FROM game_session gs
                    WHERE gs.user_id = %s
                    ORDER BY gs.created_at DESC
                    LIMIT 200
                    """,
                    (uid,),
                )
                rows = cur.fetchall()
        case_codes = [r[1] for r in rows if r[1]]
        title_by_code = get_case_titles_by_codes(DATA_DIR, case_codes)
        sessions: List[Dict[str, Any]] = []
        for r in rows:
            payload = r[2] or {}
            case_code = r[1]
            raw_title = title_by_code.get(case_code or "", "") if case_code else ""
            sessions.append({
                "session_id": r[0],
                "case_code": case_code,
                "case_id": payload.get("case_id"),
                "case_title": raw_title or case_code or "Кейс",
                "current_stage": payload.get("current_stage"),
                "created_at": r[3].isoformat() if r[3] else None,
            })
        by_user.append({
            "user_id": uid,
            "username": username,
            "sessions": sessions,
        })
    return {"by_user": by_user}


@router.get("/session/{session_id}")
async def admin_get_session(
    session_id: str,
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Получить сессию по external_id для просмотра отчёта (админ/суперюзер).
    Админ — только сессии участников своей группы.
    """
    allowed = participant_user_ids_visible_to_viewer(current_user)
    if allowed is not None:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT user_id FROM game_session WHERE external_id = %s",
                    (session_id,),
                )
                row = cur.fetchone()
        uid = row[0] if row else None
        if uid is None or uid not in allowed:
            raise HTTPException(status_code=403, detail="Нет доступа к этой сессии")
    session = get_game_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    return session


def _case_gen_user_id(current_user: Optional[Dict[str, Any]]) -> int:
    if current_user and current_user.get("id") is not None:
        try:
            return int(current_user["id"])
        except (TypeError, ValueError):
            return 0
    return 0


@router.post("/case-gen/start", dependencies=[Depends(require_admin)])
async def admin_case_gen_start(
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
    template_case_id: str = Form(...),
    creator_intent: str = Form(...),
    contract_file: Optional[UploadFile] = File(None),
    guide_file: Optional[UploadFile] = File(None),
    contract_template: Optional[str] = Form(None),
    guide: Optional[str] = Form(None),
    options: Optional[str] = Form(None),
) -> Dict[str, Any]:
    """
    Старт сессии: договор + гайд компании по работе с договорами (файл или текст) + запрос создателя → первый пакет анкеты.
    Гайд — внутренние корпоративные установки (не инструкция игроку); семантика согласована с промптами case_generation.
    """
    uid = _case_gen_user_id(current_user)
    opts: Optional[Dict[str, Any]] = None
    if options:
        try:
            opts = json.loads(options)
            if not isinstance(opts, dict):
                opts = None
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="options: невалидный JSON")
    c_file = None
    g_file = None
    try:
        if contract_file and contract_file.filename:
            b = await contract_file.read()
            c_file = (b, contract_file.filename)
        if guide_file and guide_file.filename:
            b = await guide_file.read()
            g_file = (b, guide_file.filename)
        from services.case_generation.facade import start_case_gen_session

        return start_case_gen_session(
            user_id=uid,
            template_case_id=template_case_id.strip(),
            creator_intent=creator_intent,
            contract_file=c_file,
            contract_template=contract_template,
            guide_file=g_file,
            guide=guide,
            options=opts,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/case-gen/{session_id}/answer", dependencies=[Depends(require_admin)])
async def admin_case_gen_answer(
    session_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    uid = _case_gen_user_id(current_user)
    answers = body.get("answers")
    if not isinstance(answers, dict):
        raise HTTPException(status_code=400, detail="Ожидается объект answers")
    try:
        from services.case_generation.facade import submit_case_gen_answers
        from services.case_generation.session_store import SessionForbiddenError, SessionNotFoundError

        return submit_case_gen_answers(user_id=uid, session_id=session_id, answers=answers)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Сессия не найдена или истекла")
    except SessionForbiddenError:
        raise HTTPException(status_code=403, detail="Чужая сессия")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/case-gen/{session_id}/run-generation", dependencies=[Depends(require_admin)])
async def admin_case_gen_run_generation(
    session_id: str,
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    uid = _case_gen_user_id(current_user)
    try:
        from services.case_generation.facade import run_case_gen_generation
        from services.case_generation.session_store import SessionForbiddenError, SessionNotFoundError

        return run_case_gen_generation(user_id=uid, session_id=session_id)
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail="Сессия не найдена или истекла")
    except SessionForbiddenError:
        raise HTTPException(status_code=403, detail="Чужая сессия")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.post("/generate/case-draft", dependencies=[Depends(require_admin)])
async def admin_generate_case_draft(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Устаревший одношаговый генератор с KB. Для нового потока используйте POST /api/admin/case-gen/*.

    Тело: { template_case_id, prompt, kb_doc_paths?: string[], options?: {} }
    Ответ: { draft: {...}, warnings?: string[] }
    """
    template_id = (body.get("template_case_id") or "").strip()
    if not template_id:
        raise HTTPException(status_code=400, detail="template_case_id обязателен")
    prompt = (body.get("prompt") or "").strip()
    kb_doc_paths = body.get("kb_doc_paths")
    if kb_doc_paths is not None and not isinstance(kb_doc_paths, list):
        raise HTTPException(status_code=400, detail="kb_doc_paths должен быть массивом путей")
    options = body.get("options")
    if options is not None and not isinstance(options, dict):
        options = None
    try:
        from services.admin_case_generator import generate_case_draft
        result = generate_case_draft(
            template_case_id=template_id,
            prompt=prompt,
            kb_doc_paths=kb_doc_paths,
            options=options,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/rag/stats", dependencies=[Depends(require_admin)])
async def admin_rag_stats() -> Dict[str, Any]:
    """
    Сводная статистика по RAG: документы, чанки, очередь задач.
    Используется в админке для мониторинга индексации.
    """
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                # Документы по источникам
                cur.execute(
                    """
                    SELECT source_type, COUNT(*) AS doc_count, MAX(updated_at) AS last_updated
                    FROM rag_document
                    GROUP BY source_type
                    """
                )
                docs_by_source = [
                    {
                        "source_type": row[0],
                        "count": row[1],
                        "last_updated": row[2].isoformat() if row[2] else None,
                    }
                    for row in cur.fetchall()
                ]

                # Общее количество чанков
                cur.execute("SELECT COUNT(*) FROM rag_document_chunk")
                total_chunks_row = cur.fetchone()
                total_chunks = int(total_chunks_row[0]) if total_chunks_row else 0

                # Очередь по статусам
                cur.execute(
                    """
                    SELECT status, COUNT(*) AS cnt
                    FROM rag_embedding_job
                    GROUP BY status
                    """
                )
                jobs_by_status = [{"status": row[0], "count": row[1]} for row in cur.fetchall()]

                # Очередь по source_id + статусу
                cur.execute(
                    """
                    SELECT source_id, status, COUNT(*) AS cnt
                    FROM rag_embedding_job
                    GROUP BY source_id, status
                    """
                )
                jobs_by_source_status = [
                    {"source_id": row[0], "status": row[1], "count": row[2]} for row in cur.fetchall()
                ]

        return {
            "documents_by_source": docs_by_source,
            "total_chunks": total_chunks,
            "jobs_by_status": jobs_by_status,
            "jobs_by_source_status": jobs_by_source_status,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


@router.get("/rag/jobs", dependencies=[Depends(require_admin)])
async def admin_rag_jobs(
    source_id: Optional[str] = Query(None, description="Фильтр по source_id (например, kb_markdown, cases_markdown)"),
    status: Optional[str] = Query(None, description="Фильтр по статусу задачи (pending, processing, done, error)"),
    limit: int = Query(50, ge=1, le=200),
) -> List[Dict[str, Any]]:
    """
    Просмотр очереди задач RAG.
    Возвращает последние задачи с коротким описанием ошибки (если есть).
    """
    try:
        params: List[Any] = []
        where_clauses: List[str] = []
        if source_id:
            where_clauses.append("source_id = %s")
            params.append(source_id)
        if status:
            where_clauses.append("status = %s")
            params.append(status)

        where_sql = ""
        if where_clauses:
            where_sql = "WHERE " + " AND ".join(where_clauses)

        sql = f"""
            SELECT id, source_id, source_key, status, attempt_count, last_error, next_run_at, created_at, updated_at
            FROM rag_embedding_job
            {where_sql}
            ORDER BY updated_at DESC
            LIMIT %s
        """
        params.append(limit)

        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()

        result: List[Dict[str, Any]] = []
        for row in rows:
            job = {
                "id": row[0],
                "source_id": row[1],
                "source_key": row[2],
                "status": row[3],
                "attempt_count": row[4],
                "last_error": (row[5] or "")[:200] if row[5] else None,
                "next_run_at": row[6].isoformat() if row[6] else None,
                "created_at": row[7].isoformat() if row[7] else None,
                "updated_at": row[8].isoformat() if row[8] else None,
            }
            result.append(job)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=client_500_detail_from_exception(e))


# ---------- ИИ-автопрохождение кейса (только суперюзер) ----------

class AutoplayRunBody(BaseModel):
    case_id: str
    user_id: int
    play_style: str = "master"


@router.post("/autoplay/run")
async def admin_autoplay_run(
    body: AutoplayRunBody,
    _su: Dict[str, Any] = Depends(require_superuser),
) -> Dict[str, Any]:
    """
    Старт прогона в фоне: сразу возвращает job_id (короткий HTTP — Safari и nginx не обрывают).
    Результат — GET /autoplay/status/{job_id} до status=done|error.
    """
    from services.ai_autoplay_service import _resolve_autoplay_profile, start_autoplay_job
    from services.auth_service import get_user_by_id

    ps = (body.play_style or "good").strip().lower()
    try:
        _resolve_autoplay_profile(ps)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    u = get_user_by_id(int(body.user_id))
    if not u or u.get("role") != "user":
        raise HTTPException(status_code=400, detail="Автопрогон только от имени пользователя с ролью user")
    job_id = start_autoplay_job(body.case_id, body.user_id, ps)
    return {"job_id": job_id, "status": "running"}


@router.get("/autoplay/status/{job_id}")
async def admin_autoplay_status(
    job_id: str,
    _su: Dict[str, Any] = Depends(require_superuser),
) -> Dict[str, Any]:
    """Статус фонового ИИ-прогона: running | done + result | error + error."""
    from services.ai_autoplay_service import get_autoplay_job

    rec = get_autoplay_job(job_id)
    if not rec:
        raise HTTPException(
            status_code=404,
            detail="Задание не найдено (истекло, сервер перезапускался или неверный id).",
        )
    return rec


@router.get("/contract-consistency")
async def admin_contract_consistency(
    case_id: str = Query(..., description="Кейс: case-001 или 001"),
    _su: Dict[str, Any] = Depends(require_superuser),
) -> Dict[str, Any]:
    """
    Сравнение текста пунктов договора: stage-2/contract.json и stage-3/Contract_PO.md (или dogovor_PO.md).
    Только superuser. Нормализация: пробелы, снятие префикса номера в MD, снятие ##-заголовков разделов в JSON.
    """
    from services.contract_consistency_service import compare_stage2_vs_stage3_md

    return compare_stage2_vs_stage3_md(DATA_DIR, case_id)


# ---------- Группы (только суперюзер) ----------

class CreateGroupBody(BaseModel):
    name: str


@router.get("/groups")
async def admin_list_groups(_su: Dict[str, Any] = Depends(require_superuser)) -> List[Dict[str, Any]]:
    """Список групп для назначения админам и участникам."""
    return list_groups()


@router.post("/groups")
async def admin_post_group(
    body: CreateGroupBody,
    _su: Dict[str, Any] = Depends(require_superuser),
) -> Dict[str, Any]:
    """Создать группу."""
    try:
        return create_group(body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------- Пользователи (для суперюзера и админа) ----------

class CreateUserBody(BaseModel):
    username: str
    password: str
    role: str = "user"
    email: Optional[str] = None
    group_id: Optional[int] = None


@router.get("/users")
async def admin_list_users(
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> List[Dict[str, Any]]:
    """
    Список пользователей. Суперюзер видит всех; админ — участников и админов своей группы.
    """
    return list_users_for_panel(current_user)


@router.post("/users")
async def admin_create_user(
    body: CreateUserBody,
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Создать пользователя. Суперюзер задаёт group_id для ролей admin и user.
    Админ создаёт user/admin в своей группе автоматически.
    """
    role = (body.role or "user").strip().lower()
    if role not in ("superuser", "admin", "user"):
        raise HTTPException(status_code=400, detail="Роль должна быть: superuser, admin, user")

    resolved_group_id: Optional[int] = None
    if current_user and current_user.get("role") == "admin":
        if role not in ("user", "admin"):
            raise HTTPException(
                status_code=403,
                detail="Админ может создавать только пользователей и администраторов своей группы",
            )
        ag = current_user.get("group_id")
        if not ag:
            raise HTTPException(status_code=400, detail="У вашей учётной записи не задана группа. Обратитесь к суперюзеру.")
        resolved_group_id = int(ag)
    elif current_user and current_user.get("role") == "superuser":
        if role == "superuser":
            resolved_group_id = None
        else:
            gid = body.group_id
            if gid is None or not group_exists(gid):
                raise HTTPException(
                    status_code=400,
                    detail="Для ролей admin и user укажите существующий group_id (создайте группу на вкладке пользователей)",
                )
            resolved_group_id = int(gid)
    else:
        if role == "superuser":
            resolved_group_id = None
        else:
            gid = body.group_id
            if gid is None or not group_exists(gid):
                raise HTTPException(status_code=400, detail="Для ролей admin и user укажите существующий group_id")
            resolved_group_id = int(gid)

    try:
        return create_user(
            username=body.username,
            password=body.password,
            role=role,
            email=body.email,
            group_id=resolved_group_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/users/{user_id}")
async def admin_delete_user(
    user_id: int,
    current_user: Optional[Dict[str, Any]] = Depends(require_admin),
) -> Dict[str, Any]:
    """
    Удалить пользователя. Суперюзер — любого (кроме ограничений БД).
    Админ — только участников (user) своей группы; других админов удалять нельзя.
    """
    target = get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if current_user and current_user.get("role") == "admin":
        if target.get("role") == "admin":
            raise HTTPException(status_code=403, detail="Админ не может удалять других администраторов")
        if target.get("role") != "user":
            raise HTTPException(status_code=403, detail="Админ может удалять только участников (роль user)")
        ag = current_user.get("group_id")
        tg = target.get("group_id")
        if ag is None or tg is None or int(ag) != int(tg):
            raise HTTPException(status_code=403, detail="Нельзя удалить пользователя из другой группы")
    delete_user(user_id)
    return {"ok": True, "id": user_id}
