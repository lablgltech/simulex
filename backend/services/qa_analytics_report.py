"""
Автоматический отчёт по замечаниям QA: агрегаты, анализ текстов и (опционально) скриншотов вложений.

Доступ к ИИ — тот же, что у остальных сервисов: `services.ai_chat_service.call_openai` и
`get_model_for_consumer("report")` (поле report_model в data/ai_model_config.json / админке).
Ключи и сеть: OPENAI_API_KEY, OPENROUTER_API_KEY, OPENAI_BASE_URL, OPENROUTER_BASE_URL,
OPENAI_PROXY, OPENAI_PROXY_TOKEN, OPENAI_TIMEOUT, OPENAI_SSL_VERIFY — без отдельного канала для QA.

Переменные QA_REPORT_* — только локальные переключатели этого отчёта (vision, лимиты, отключение LLM).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from psycopg2.extras import Json

from db import get_connection
from services.qa_bug_service import (
    QA_AREAS,
    QA_FINDING_TYPES,
    QA_SEVERITIES,
    QA_UPLOAD_DIR,
    user_can_access_qa_tracker,
)
from services.ai_payload import MINIMAL_SYSTEM_MESSAGE

logger = logging.getLogger(__name__)

_QA_REPORT_LLM_MAX_DESC = 2000
_QA_REPORT_LLM_MAX_TOKENS = 6000

                                                                 
_SAFE_QA_FILENAME = re.compile(r"^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif)$", re.IGNORECASE)

AREA_LABELS_RU: Dict[str, str] = {
    "этап_1_целиком": "Этап 1 (целиком)",
    "этап_1_чат": "Этап 1 (чат)",
    "этап_2_целиком": "Этап 2 (целиком)",
    "этап_3_целиком": "Этап 3 (целиком)",
    "этап_3_чат": "Этап 3 (чат)",
    "этап_4_целиком": "Этап 4 (целиком)",
    "обучение_тур": "Обучение / тур",
    "отчёт_участника": "Отчёт участника",
    "админка": "Админка",
    "прочее": "Прочее",
}

FINDING_LABELS_RU: Dict[str, str] = {
    "логика": "логика и сценарии",
    "интерфейс": "интерфейс и UX",
    "контент_методика": "контент и методика",
    "производительность": "производительность",
    "доступность": "доступность",
    "другое": "прочие наблюдения",
}

_REC_BY_FINDING: Dict[str, Tuple[str, str, str]] = {
    "логика": (
        "Уточнить сценарии и краевые случаи",
        "Свести описания воспроизведения к чек-листу и прогнать регрессию по затронутым веткам сценария.",
        "Логические ошибки часто связаны с неполным покрытием веток; явные шаги снижают риск повторной регрессии.",
    ),
    "интерфейс": (
        "Проход по UI с единым гайдлайном",
        "Согласовать отступы, подписи, состояния кнопок и обратную связь при ошибках; при необходимости — короткий UX-ревью.",
        "Сгруппированные замечания по интерфейсу обычно дешевле закрывать пакетом, чем точечно.",
    ),
    "контент_методика": (
        "Ревью текстов и методических формулировок",
        "Передать формулировки методисту/редактору и зафиксировать эталонные формулировки в контент-гайде.",
        "Расхождения в формулировках влияют на понимание задания участником.",
    ),
    "производительность": (
        "Измерить и локализовать узкие места",
        "Собрать профили (сеть, рендер, БД), воспроизвести на эталонном окружении и внедрить целевые оптимизации.",
        "Без измерений оптимизация часто бьёт не в ту сторону; замеры дают аргумент для приоритета.",
    ),
    "доступность": (
        "Чек-лист a11y",
        "Проверить контраст, фокус, клавиатурную навигацию и семантику под рекомендациями WCAG.",
        "Доступность улучшает опыт для всех пользователей и снижает юридические/репутационные риски.",
    ),
    "другое": (
        "Классифицировать и разнести по типам",
        "Переформулировать замечания в духе «область + тип + шаги», чтобы их можно было планировать в бэклоге.",
        "Смешанный тип затрудняет оценку трудозатрат; уточнение типа помогает командам.",
    ),
}


def area_label_ru(code: str) -> str:
    return AREA_LABELS_RU.get(code, code)


def _bugs_fingerprint(bugs: List[Dict[str, Any]]) -> str:
    parts = []
    for b in bugs:
        bid = b.get("id")
        ts = b.get("updated_at") or b.get("created_at") or ""
        parts.append(f"{bid}:{ts}")
    parts.sort()
    raw = "|".join(parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def _count_map(counter: Counter, keys: frozenset) -> Dict[str, int]:
    return {k: int(counter.get(k, 0)) for k in sorted(keys)}


def _description_preview(desc: str, max_chars: int = 140) -> str:
    s = (desc or "").strip().replace("\n", " ")
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1] + "…"


def _truncate_for_llm(desc: str, max_chars: int = _QA_REPORT_LLM_MAX_DESC) -> str:
    s = (desc or "").strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1] + "…"


def _norm_bug_ids(raw: Any) -> List[int]:
    out: List[int] = []
    if raw is None:
        return out
    if not isinstance(raw, list):
        return out
    for x in raw:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


_QA_LLM_SYSTEM = MINIMAL_SYSTEM_MESSAGE


def _qa_mime_for_file(path: Path) -> Optional[str]:
    ext = path.suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext)


def _attachment_count(bug: Dict[str, Any]) -> int:
    att = bug.get("attachments")
    if not isinstance(att, list):
        return 0
    return sum(1 for x in att if x is not None)


def _build_llm_user_content(
    compact_json_str: str,
    bugs_new: List[Dict[str, Any]],
) -> Tuple[Union[str, List[Dict[str, Any]]], int]:
    """
    Текстовый JSON или мультимодальный массив частей (OpenAI-совместимый chat).
    Возвращает (content, число реально отправленных изображений).
    """
    vision_env = (os.getenv("QA_REPORT_LLM_VISION", "1")).strip().lower()
    if vision_env in ("0", "false", "no", "off"):
        return compact_json_str, 0

    try:
        per_bug = max(1, int(os.getenv("QA_REPORT_LLM_MAX_IMAGES_PER_BUG", "2")))
    except ValueError:
        per_bug = 2
    try:
        max_total = max(1, int(os.getenv("QA_REPORT_LLM_MAX_IMAGES_TOTAL", "16")))
    except ValueError:
        max_total = 16
    try:
        max_bytes = int(os.getenv("QA_REPORT_LLM_MAX_IMAGE_BYTES", str(4 * 1024 * 1024)))
    except ValueError:
        max_bytes = 4 * 1024 * 1024

    detail = (os.getenv("QA_REPORT_LLM_IMAGE_DETAIL") or "low").strip().lower()
    if detail not in ("low", "high", "auto"):
        detail = "low"

    upload_dir = Path(QA_UPLOAD_DIR)
    parts: List[Dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "Данные замечаний (JSON):\n"
                + compact_json_str
                + "\n\nПоле attachment_count — сколько файлов прикреплено к замечанию; часть из них может быть продублирована ниже как изображения.\n"
                "Каждый следующий блок «Изображение к замечанию #…» относится к одному скрину; используй это в анализе вместе с текстом description."
            ),
        }
    ]
    sent = 0
    sorted_bugs = sorted(bugs_new, key=lambda x: int(x.get("id") or 0))
    for b in sorted_bugs:
        if sent >= max_total:
            break
        bid = b.get("id")
        n_for_bug = 0
        attachments = b.get("attachments") or []
        if not isinstance(attachments, list):
            continue
        for a in attachments:
            if n_for_bug >= per_bug or sent >= max_total:
                break
            name: Optional[str] = None
            if isinstance(a, dict):
                name = a.get("name")
                if isinstance(name, str):
                    name = name.strip()
            elif isinstance(a, str):
                name = a.strip()
            if not name or not _SAFE_QA_FILENAME.match(name):
                continue
            path = upload_dir / name
            try:
                path_resolved = path.resolve()
                upload_resolved = upload_dir.resolve()
                path_resolved.relative_to(upload_resolved)
            except (OSError, ValueError):
                continue
            if not path.is_file():
                continue
            try:
                rawb = path.read_bytes()
            except OSError:
                continue
            if len(rawb) > max_bytes or len(rawb) < 32:
                continue
            mime = _qa_mime_for_file(path)
            if not mime:
                continue
            b64 = base64.standard_b64encode(rawb).decode("ascii")
            data_url = f"data:{mime};base64,{b64}"
            parts.append({"type": "text", "text": f"Изображение к замечанию #{bid} (вложение «{name}»):"})
            parts.append({"type": "image_url", "image_url": {"url": data_url, "detail": detail}})
            sent += 1
            n_for_bug += 1

    if sent == 0:
        return compact_json_str, 0
    return parts, sent


def enrich_payload_with_llm_analysis(payload: Dict[str, Any], bugs: List[Dict[str, Any]]) -> None:
    """
    Дополняет payload полями анализа (LLM), опционально с изображениями вложений.
    Мутирует payload, выставляет version=4. При ошибке — llm.ok=false.
    """
    bugs_new = [b for b in bugs if (b.get("status") or "").strip() == "new"]
    payload["version"] = 4

    if not bugs_new:
        payload["llm"] = {"ok": False, "skipped": True, "reason": "no_bugs"}
        return

    flag = (os.getenv("QA_REPORT_LLM") or "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        payload["llm"] = {"ok": False, "skipped": True, "reason": "disabled"}
        payload["content_overview"] = ""
        for block in payload.get("areas") or []:
            if isinstance(block, dict):
                block["content_narrative"] = ""
                block["content_themes"] = []
        return

    compact: List[Dict[str, Any]] = []
    for b in bugs_new:
        compact.append(
            {
                "id": b.get("id"),
                "area": b.get("area"),
                "severity": b.get("severity"),
                "finding_type": b.get("finding_type"),
                "description": _truncate_for_llm(b.get("description") or ""),
                "attachment_count": _attachment_count(b),
            }
        )

    try:
        from services.ai_chat_service import call_openai, _extract_json_from_text
        from services.ai_model_config import get_model_for_consumer

        model = get_model_for_consumer("report")
        user_body = json.dumps(compact, ensure_ascii=False)
        user_content, images_sent = _build_llm_user_content(user_body, bugs_new)
        try:
            _mt_env = int(os.getenv("QA_REPORT_LLM_MAX_TOKENS", str(_QA_REPORT_LLM_MAX_TOKENS)))
        except ValueError:
            _mt_env = _QA_REPORT_LLM_MAX_TOKENS
        _mt = max(800, min(_QA_REPORT_LLM_MAX_TOKENS, _mt_env))
        if images_sent:
            _mt = min(_QA_REPORT_LLM_MAX_TOKENS, int(_mt * 1.25))

        llm_payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": _QA_LLM_SYSTEM},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0.25,
            "max_tokens": _mt,
        }
        raw = call_openai(llm_payload)
        parsed = _extract_json_from_text(raw)
        if not isinstance(parsed, dict):
            raise ValueError("Ответ не JSON-объект")

        overview = str(parsed.get("overview") or "").strip()
        payload["content_overview"] = overview
        payload["llm"] = {
            "ok": True,
            "model": model,
            "images_sent": images_sent,
            "vision_enabled": images_sent > 0,
        }

        llm_by_area: Dict[str, Dict[str, Any]] = {}
        for row in parsed.get("areas") or []:
            if not isinstance(row, dict):
                continue
            code = str(row.get("area") or "").strip()
            if code and code not in llm_by_area:
                llm_by_area[code] = row

        ids_by_area: Dict[str, set] = defaultdict(set)
        for b in bugs_new:
            a = str(b.get("area") or "").strip()
            try:
                ids_by_area[a].add(int(b["id"]))
            except (TypeError, ValueError, KeyError):
                continue

        for block in payload.get("areas") or []:
            if not isinstance(block, dict):
                continue
            code = str(block.get("area") or "").strip()
            la = llm_by_area.get(code)
            if not la:
                block["content_narrative"] = ""
                block["content_themes"] = []
                continue

            block["content_narrative"] = str(la.get("narrative") or "").strip()
            valid_ids = ids_by_area.get(code, set())
            themes_out: List[Dict[str, Any]] = []
            for t in la.get("themes") or []:
                if not isinstance(t, dict):
                    continue
                bids = [i for i in _norm_bug_ids(t.get("bug_ids")) if i in valid_ids]
                themes_out.append(
                    {
                        "title": str(t.get("title") or "").strip(),
                        "bug_ids": bids,
                        "explanation": str(t.get("explanation") or "").strip(),
                    }
                )
            block["content_themes"] = themes_out

            llm_recs: List[Dict[str, Any]] = []
            for r in la.get("suggested_actions") or []:
                if not isinstance(r, dict):
                    continue
                title = str(r.get("title") or "").strip()
                body = str(r.get("body") or "").strip()
                if not title or not body:
                    continue
                bids = [i for i in _norm_bug_ids(r.get("bug_ids")) if i in valid_ids]
                llm_recs.append(
                    {
                        "title": title,
                        "body": body,
                        "rationale": str(r.get("rationale") or "").strip(),
                        "bug_ids": bids,
                        "source": "llm",
                    }
                )
            if llm_recs:
                block["recommendations"] = llm_recs
    except Exception as e:
        logger.exception("QA analytics LLM enrichment failed: %s", e)
        payload["llm"] = {"ok": False, "error": str(e)[:500]}
        payload.setdefault("content_overview", "")
        for block in payload.get("areas") or []:
            if isinstance(block, dict):
                block.setdefault("content_narrative", "")
                block.setdefault("content_themes", [])


def _dominant(counter: Counter) -> Optional[str]:
    if not counter:
        return None
    return counter.most_common(1)[0][0]


def _area_summary(area: str, area_bugs: List[Dict[str, Any]]) -> List[str]:
    n = len(area_bugs)
    if n == 0:
        return []
    sev_c = Counter(b.get("severity") or "" for b in area_bugs)
    ft_c = Counter(b.get("finding_type") or "" for b in area_bugs)
    dom_ft = _dominant(ft_c)
    dom_sev = _dominant(sev_c)
    label = area_label_ru(area)
    p1 = (
        f"В области «{label}» зафиксировано {n} "
        f"замечани{'е' if n == 1 else 'я' if 2 <= n <= 4 else 'й'}."
    )
    extra = []
    if dom_ft:
        cnt = ft_c[dom_ft]
        fl = FINDING_LABELS_RU.get(dom_ft, dom_ft)
        extra.append(f"Чаще всего встречается тип «{fl}» ({cnt} из {n}).")
    if dom_sev:
        extra.append(f"По критичности лидирует уровень «{dom_sev}» ({sev_c[dom_sev]} из {n}).")
    openish = sum(1 for b in area_bugs if (b.get("status") or "") not in ("done", "wontfix"))
    if openish and openish != n:
        extra.append(f"В работе / не закрыто: {openish} из {n}.")
    elif openish == n and n > 2:
        extra.append("Все перечисленные замечания ещё не переведены в статус «Готово» или «Не исправляем».")
    return [p1] + extra


def _recommendations_for_area(area: str, area_bugs: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    ft_c = Counter(b.get("finding_type") or "" for b in area_bugs)
    sev_c = Counter(b.get("severity") or "" for b in area_bugs)
    high_n = sev_c.get("высокая", 0)
    if high_n:
        out.append(
            {
                "title": "Приоритет высокой критичности",
                "body": f"В этой области {high_n} замечани{'е' if high_n == 1 else 'я' if 2 <= high_n <= 4 else 'й'} с уровнем «высокая». Имеет смысл закрыть их в первую очередь или явно зафиксировать отложенный срок.",
                "rationale": "Высокая критичность обычно связана с блокирующими дефектами или риском для обучения и данных.",
            }
        )
    for ft, cnt in ft_c.most_common():
        if ft not in _REC_BY_FINDING:
            continue
        title, body, rationale = _REC_BY_FINDING[ft]
        fl = FINDING_LABELS_RU.get(ft, ft)
        out.append(
            {
                "title": title,
                "body": f"{body} (в области «{area_label_ru(area)}» таких замечаний: {cnt}.)",
                "rationale": rationale,
            }
        )
                           
    seen = set()
    uniq: List[Dict[str, str]] = []
    for r in out:
        t = r["title"]
        if t in seen:
            continue
        seen.add(t)
        uniq.append(r)
    return uniq[:6]


def build_analytics_payload(bugs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Собирает JSON отчёта из списка замечаний в формате API QA.
    Учитываются только записи со статусом «new» (в интерфейсе — «Новое»).
    """
    bugs = [b for b in bugs if (b.get("status") or "").strip() == "new"]
    now = datetime.now(timezone.utc).isoformat()
    total = len(bugs)
    sev_c = Counter(b.get("severity") or "" for b in bugs)
    area_c = Counter(b.get("area") or "" for b in bugs)
    ft_c = Counter(b.get("finding_type") or "" for b in bugs)

    by_area: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for b in bugs:
        a = b.get("area") or "прочее"
        by_area[a].append(b)

    area_blocks: List[Dict[str, Any]] = []
    for area in sorted(QA_AREAS, key=lambda x: area_label_ru(x)):
        arr = by_area.get(area, [])
        if not arr:
            continue
        arr_sorted = sorted(arr, key=lambda x: (-_severity_rank(x.get("severity")), -int(x.get("id") or 0)))
        area_blocks.append(
            {
                "area": area,
                "area_label_ru": area_label_ru(area),
                "summary": _area_summary(area, arr_sorted),
                "bugs": [
                    {
                        "id": b["id"],
                        "severity": b.get("severity"),
                        "finding_type": b.get("finding_type"),
                        "finding_type_label_ru": FINDING_LABELS_RU.get(b.get("finding_type") or "", b.get("finding_type")),
                        "status": b.get("status"),
                        "description_preview": _description_preview(b.get("description") or ""),
                        "attachment_count": _attachment_count(b),
                        "created_at": b.get("created_at"),
                    }
                    for b in arr_sorted
                ],
                "recommendations": _recommendations_for_area(area, arr_sorted),
            }
        )

    return {
        "version": 2,
        "generated_at": now,
        "bugs_fingerprint": _bugs_fingerprint(bugs),
        "stats": {
            "total": total,
            "by_severity": _count_map(sev_c, QA_SEVERITIES),
            "by_area": {k: area_c.get(k, 0) for k in sorted(QA_AREAS)},
            "by_finding_type": _count_map(ft_c, QA_FINDING_TYPES),
        },
        "areas": area_blocks,
    }


def _severity_rank(sev: Optional[str]) -> int:
    order = {"высокая": 3, "средняя": 2, "низкая": 1}
    return order.get((sev or "").strip().lower(), 0)


def report_scope_for_viewer(viewer: Dict[str, Any]) -> Tuple[str, int]:
    """('group', gid) или ('user', uid) — должен совпадать с областью видимости списка багов."""
    role = viewer.get("role") or "user"
    vid = int(viewer["id"])
    vgid = viewer.get("group_id")
    scoped_by_group = bool(vgid) and (
        user_can_access_qa_tracker(viewer) or role in ("superuser", "admin")
    )
    if scoped_by_group:
        return "group", int(vgid)
    return "user", vid


def load_saved_report(viewer: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    kind, sid = report_scope_for_viewer(viewer)
    col = "scope_group_id" if kind == "group" else "scope_user_id"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT payload, updated_at FROM qa_analytics_report WHERE {col} = %s",
                (sid,),
            )
            row = cur.fetchone()
    if not row:
        return None
    payload, updated_at = row
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "payload": payload,
        "stored_at": updated_at.isoformat() if updated_at else None,
    }


def save_report(viewer: Dict[str, Any], payload: Dict[str, Any]) -> str:
    kind, sid = report_scope_for_viewer(viewer)
    with get_connection() as conn:
        with conn.cursor() as cur:
            if kind == "group":
                cur.execute(
                    "SELECT id FROM qa_analytics_report WHERE scope_group_id = %s",
                    (sid,),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE qa_analytics_report SET payload = %s, updated_at = NOW() WHERE scope_group_id = %s",
                        (Json(payload), sid),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO qa_analytics_report (scope_group_id, scope_user_id, payload, updated_at)
                        VALUES (%s, NULL, %s, NOW())
                        """,
                        (sid, Json(payload)),
                    )
            else:
                cur.execute(
                    "SELECT id FROM qa_analytics_report WHERE scope_user_id = %s",
                    (sid,),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE qa_analytics_report SET payload = %s, updated_at = NOW() WHERE scope_user_id = %s",
                        (Json(payload), sid),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO qa_analytics_report (scope_group_id, scope_user_id, payload, updated_at)
                        VALUES (NULL, %s, %s, NOW())
                        """,
                        (sid, Json(payload)),
                    )
    return str(payload.get("generated_at") or "")


def fetch_or_generate_report(viewer: Dict[str, Any]) -> Dict[str, Any]:
    """Возвращает отчёт из БД или строит, сохраняет и возвращает при первом обращении."""
    from services.qa_bug_service import list_bugs_for_viewer

    saved = load_saved_report(viewer)
    pl = saved.get("payload") if saved else None
    try:
        ver = int(pl.get("version") or 0) if isinstance(pl, dict) else 0
    except (TypeError, ValueError):
        ver = 0
    if saved and isinstance(pl, dict) and ver >= 4:
        return {
            "payload": saved["payload"],
            "stored_at": saved.get("stored_at"),
            "from_cache": True,
        }
    bugs = list_bugs_for_viewer(viewer)
    payload = build_analytics_payload(bugs)
    enrich_payload_with_llm_analysis(payload, bugs)
    save_report(viewer, payload)
    reloaded = load_saved_report(viewer)
    return {
        "payload": payload,
        "stored_at": (reloaded or {}).get("stored_at") or payload.get("generated_at"),
        "from_cache": False,
    }


def refresh_report(viewer: Dict[str, Any]) -> Dict[str, Any]:
    from services.qa_bug_service import list_bugs_for_viewer

    bugs = list_bugs_for_viewer(viewer)
    payload = build_analytics_payload(bugs)
    enrich_payload_with_llm_analysis(payload, bugs)
    save_report(viewer, payload)
    reloaded = load_saved_report(viewer)
    return {
        "payload": payload,
        "stored_at": (reloaded or {}).get("stored_at") or payload.get("generated_at"),
        "from_cache": False,
    }

