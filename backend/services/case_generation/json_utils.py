"""Извлечение JSON из ответа LLM."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger(__name__)

try:
    from json_repair import repair_json as _repair_json                                
except ImportError:
    _repair_json = None


def _looks_like_questionnaire_root(d: dict) -> bool:
    return "questions" in d or "questionnaire_complete" in d


def _looks_like_question_item(d: dict) -> bool:
    return bool(
        d.get("prompt")
        or d.get("question")
        or d.get("text")
        or d.get("title")
        or d.get("content")
        or d.get("body")
        or d.get("query")
        or d.get("label")
        or d.get("description")
        or d.get("question_text")
        or d.get("message")
    )


def _serialize_json_value(v: Any) -> str:
    try:
        return json.dumps(v, ensure_ascii=False)
    except (TypeError, ValueError):
        return ""


def _maybe_parse_json_string(s: str) -> Optional[Any]:
    s = (s or "").strip()
    if not s or (not s.startswith("{") and not s.startswith("[")):
        return None
    for variant in (s, _strip_trailing_commas_json(s)):
        try:
            return json.loads(variant)
        except json.JSONDecodeError:
            continue
    return None


def _json_from_string_field(v: Any) -> Optional[str]:
    """Если v — строка с JSON, вернуть нормализованную JSON-строку объекта/массива."""
    if not isinstance(v, str) or not v.strip():
        return None
    parsed = _maybe_parse_json_string(v)
    if parsed is None:
        return None
    return _serialize_json_value(parsed)


def _text_from_nested_piece(piece: Any) -> str:
    """Рекурсивно вытащить текст из вложенных структур (Gemini / OpenRouter)."""
    if piece is None:
        return ""
    if isinstance(piece, str):
        return piece
    if isinstance(piece, list):
        return "".join(_text_from_nested_piece(x) for x in piece)
    if isinstance(piece, dict):
        if "text" in piece:
            t = _text_from_nested_piece(piece["text"])
            if t:
                return t
        ct = piece.get("content")
        if isinstance(ct, str) and ct.strip():
            return ct
        for key in ("json", "parsed", "output", "data", "arguments", "args"):
            v = piece.get(key)
            if isinstance(v, dict):
                ser = _serialize_json_value(v)
                if ser:
                    return ser
            if isinstance(v, str) and v.strip():
                inner = _maybe_parse_json_string(v)
                if inner is not None:
                    return _serialize_json_value(inner)
                return v.strip()
        if piece.get("type") == "refusal" and piece.get("refusal"):
            return str(piece["refusal"])
        if _looks_like_questionnaire_root(piece):
            ser = _serialize_json_value(piece)
            if ser:
                return ser
        return ""
    return str(piece)


def _additional_kwargs_text(message: Any) -> str:
    ak = getattr(message, "additional_kwargs", None) or {}
    if not isinstance(ak, dict):
        return ""
    for key in ("parsed", "refusal", "reasoning_content"):
        v = ak.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, dict) and _looks_like_questionnaire_root(v):
            return _serialize_json_value(v)
    return ""


def assistant_plain_text_for_json(message: Any) -> str:
    """
    Текст ответа ассистента для извлечения JSON.
    Сначала LangChain BaseMessage.text() (совместимость с провайдерами),
    затем разбор content; если пусто — tool_calls.args и вложенные json-блоки.
    """
    text_fn = getattr(message, "text", None)
    if callable(text_fn):
        try:
            t = text_fn()
            if isinstance(t, str) and t.strip():
                return t.strip()
        except Exception:
            pass

    content = getattr(message, "content", message)
    t2 = message_content_as_text(content)
    if isinstance(t2, str) and t2.strip():
        return t2.strip()

    ak_text = _additional_kwargs_text(message)
    if ak_text:
        return ak_text.strip()

    tcs = getattr(message, "tool_calls", None) or []
    if isinstance(tcs, list):
        for tc in tcs:
            if not isinstance(tc, dict):
                continue
            args = tc.get("args")
            if isinstance(args, dict) and args:
                try:
                    return json.dumps(args, ensure_ascii=False).strip()
                except (TypeError, ValueError):
                    continue

    if isinstance(content, list):
        chunks: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype in ("reasoning", "thought", "thinking"):
                continue
            for key in ("json", "parsed", "output", "data"):
                v = block.get(key)
                if isinstance(v, dict):
                    try:
                        chunks.append(json.dumps(v, ensure_ascii=False))
                    except (TypeError, ValueError):
                        pass
                elif isinstance(v, str) and v.strip():
                    inner = _maybe_parse_json_string(v)
                    if inner is not None:
                        chunks.append(_serialize_json_value(inner))
                    else:
                        chunks.append(v.strip())
            if _looks_like_questionnaire_root(block):
                try:
                    chunks.append(json.dumps(block, ensure_ascii=False))
                except (TypeError, ValueError):
                    pass
        joined = "\n".join(c for c in chunks if c)
        if joined.strip():
            return joined.strip()

    return (t2 or "").strip()


def describe_assistant_message_for_log(message: Any) -> Dict[str, Any]:
    """Компактное описание ответа модели для логов (без секретов)."""
    out: Dict[str, Any] = {}
    content = getattr(message, "content", None)
    out["content_type"] = type(content).__name__
    if isinstance(content, list):
        keys_list: List[List[str]] = []
        for b in content[:8]:
            if isinstance(b, dict):
                keys_list.append(sorted(str(k) for k in b.keys())[:16])
            else:
                keys_list.append([])
        out["block_key_sets"] = keys_list
    rm = getattr(message, "response_metadata", None) or {}
    if isinstance(rm, dict):
        out["finish_reason"] = rm.get("finish_reason")
        if rm.get("model"):
            out["model"] = str(rm.get("model"))[:80]
    return out


def message_content_as_text(content: Any) -> str:
    """
    AIMessage.content у части моделей (Gemini и др. через OpenRouter) — не str,
    а список блоков вида [{"type": "text", "text": "..."}]. str(content) даёт
    Python-репр и ломает extract_json_object.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                parts.append(_text_from_nested_piece(block))
            else:
                parts.append(str(block))
        return "".join(parts)
    if isinstance(content, dict):
        return _text_from_nested_piece(content)
    return str(content)


def _normalize_jsonish_text(text: str) -> str:
    t = (text or "").strip()
    t = t.replace("\ufeff", "")
    for a, b in (
        ("\u201c", '"'),
        ("\u201d", '"'),
        ("\u00ab", '"'),
        ("\u00bb", '"'),
        ("\u2018", "'"),
        ("\u2019", "'"),
    ):
        t = t.replace(a, b)
    return t


def _first_balanced_object_slice(s: str) -> Optional[str]:
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    i = start
    while i < len(s):
        c = s[i]
        if escape:
            escape = False
            i += 1
            continue
        if in_string:
            if c == "\\":
                escape = True
            elif c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
        i += 1
    return None


def _first_balanced_array_slice(s: str) -> Optional[str]:
    start = s.find("[")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    i = start
    while i < len(s):
        c = s[i]
        if escape:
            escape = False
            i += 1
            continue
        if in_string:
            if c == "\\":
                escape = True
            elif c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            i += 1
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
        i += 1
    return None


def _strip_trailing_commas_json(s: str) -> str:
    out = re.sub(r",(\s*})", r"\1", s)
    out = re.sub(r",(\s*])", r"\1", out)
    return out


def _try_load_dict(s: str) -> Optional[Dict[str, Any]]:
    s = s.strip()
    if not s:
        return None
    for variant in (s, _strip_trailing_commas_json(s)):
        try:
            obj = json.loads(variant)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            continue
    return None


def _try_load_any(s: str) -> Optional[Union[Dict[str, Any], List[Any]]]:
    s = s.strip()
    if not s:
        return None
    for variant in (s, _strip_trailing_commas_json(s)):
        try:
            obj = json.loads(variant)
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def _try_repair_then_dict(s: str) -> Optional[Dict[str, Any]]:
    if not _repair_json or not s:
        return None
                                                                              
    if len(s) > 80_000:
        return None
    try:
        fixed = _repair_json(s)
        if not isinstance(fixed, str):
            fixed = str(fixed)
        obj = json.loads(fixed)
        if isinstance(obj, dict):
            return obj
        if isinstance(obj, list):
            return normalize_questionnaire_payload(obj)
    except RecursionError:
        logger.debug("json_repair RecursionError, skip repair path")
        return None
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        logger.debug("json_repair path failed: %s", e)
    except Exception as e:
        logger.debug("json_repair unexpected: %s", e)
    return None


def normalize_questionnaire_payload(obj: Any) -> Optional[Dict[str, Any]]:
    """
    Привести произвольный JSON (dict или list) к виду с ключами
    questionnaire_complete, questions, rationale_short.
    """
    if obj is None:
        return None
    if isinstance(obj, list):
                                                                                                         
        if not obj:
            return None
        if all(isinstance(x, dict) for x in obj):
            if any(_looks_like_question_item(x) for x in obj):
                return {"questionnaire_complete": False, "questions": obj, "rationale_short": ""}
        return None
    if not isinstance(obj, dict):
        return None
    d = dict(obj)
    qc = d.get("questions")
    if isinstance(qc, str) and qc.strip():
        inner = _maybe_parse_json_string(qc)
        if isinstance(inner, list):
            d["questions"] = inner
        elif isinstance(inner, dict):
            merged = {**d, **inner}
            if "questions" in merged:
                d = merged
    if not isinstance(d.get("questions"), list):
        d["questions"] = []
    d.setdefault("questionnaire_complete", False)
    d.setdefault("rationale_short", d.get("rationale_short") or "")
    return d


def extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    text = _normalize_jsonish_text(text)
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        inner = match.group(1).strip()
        got = _try_load_dict(inner)
        if got is not None:
            return got
        bal = _first_balanced_object_slice(inner)
        if bal:
            got = _try_load_dict(bal)
            if got is not None:
                return got

    got = _try_load_dict(text)
    if got is not None:
        return got

    bal = _first_balanced_object_slice(text)
    if bal:
        got = _try_load_dict(bal)
        if got is not None:
            return got

    start = text.find("{")
    if start >= 0:
        end = text.rfind("}") + 1
        if end > start:
            got = _try_load_dict(text[start:end])
            if got is not None:
                return got
    return None


def extract_json_for_questionnaire(text: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """
    Извлечь объект анкеты; второе значение — стадия для диагностики:
    ok | empty_text | from_object | from_array | from_repair | decode_failed
    """
    raw = (text or "").strip()
    if not raw:
        return None, "empty_text"

    norm = _normalize_jsonish_text(raw)

                                                                                 
    lead = norm.lstrip()
    if lead.startswith("["):
        arr_slice = _first_balanced_array_slice(norm)
        if arr_slice:
            lst = _try_load_any(arr_slice)
            if isinstance(lst, list):
                out = normalize_questionnaire_payload(lst)
                if out:
                    return out, "from_array"

    d = extract_json_object(norm)
    if d is not None:
        out = normalize_questionnaire_payload(d)
        return out, "from_object" if out else "decode_failed"

    arr_slice = _first_balanced_array_slice(norm)
    if arr_slice:
        lst = _try_load_any(arr_slice)
        if isinstance(lst, list):
            out = normalize_questionnaire_payload(lst)
            if out:
                return out, "from_array"

    any_root = _try_load_any(norm)
    if isinstance(any_root, list):
        out = normalize_questionnaire_payload(any_root)
        if out:
            return out, "from_array"
    if isinstance(any_root, dict):
        out = normalize_questionnaire_payload(any_root)
        if out:
            return out, "from_object"

    repaired = _try_repair_then_dict(norm)
    if repaired is not None:
        out = normalize_questionnaire_payload(repaired)
        if out:
            return out, "from_repair"

    return None, "decode_failed"
