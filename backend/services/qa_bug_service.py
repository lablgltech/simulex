"""
Простой QA-трекер: создание и выборка замечаний с учётом ролей и групп.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json

from config import DATA_DIR
from db import get_connection

QA_UPLOAD_DIR = Path(DATA_DIR) / "uploads" / "qa"

                                                                      
_QA_STORED_FILENAME = re.compile(r"^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif)$", re.IGNORECASE)

QA_AREAS = frozenset(
    {
        "этап_1_целиком",
        "этап_1_чат",
        "этап_2_целиком",
        "этап_3_целиком",
        "этап_3_чат",
        "этап_4_целиком",
        "обучение_тур",
        "отчёт_участника",
        "админка",
        "прочее",
    }
)

QA_FINDING_TYPES = frozenset(
    {
        "логика",
        "интерфейс",
        "контент_методика",
        "производительность",
        "доступность",
        "другое",
    }
)

QA_SEVERITIES = frozenset({"высокая", "средняя", "низкая"})

QA_STATUSES = frozenset({"new", "triaged", "in_progress", "done", "wontfix"})

                                                                          
QA_TRACKER_GROUP_NAME = "ЛабЛигалТех"


def user_can_access_qa_tracker(user: Optional[Dict[str, Any]]) -> bool:
    if not user:
        return False
    name = (user.get("group_name") or "").strip()
    return name == QA_TRACKER_GROUP_NAME


def user_can_restart_simulator_stage(user: Optional[Dict[str, Any]]) -> bool:
    """Сброс этапа в симуляторе: группа ЛабЛигалТех или роли superuser / admin (как QA/отчёты)."""
    if not user:
        return False
    role = str(user.get("role") or "").strip().lower()
    if role in ("superuser", "admin"):
        return True
    return user_can_access_qa_tracker(user)


def normalize_area(v: str) -> str:
    s = (v or "").strip()
    if s not in QA_AREAS:
        raise ValueError(f"area должна быть одной из: {', '.join(sorted(QA_AREAS))}")
    return s


def normalize_finding_type(v: str) -> str:
    s = (v or "").strip()
    if s not in QA_FINDING_TYPES:
        raise ValueError(f"finding_type: {', '.join(sorted(QA_FINDING_TYPES))}")
    return s


def normalize_severity(v: str) -> str:
    s = (v or "").strip().lower()
                           
    if s == "высокая":
        return "высокая"
    if s == "средняя":
        return "средняя"
    if s == "низкая":
        return "низкая"
    raise ValueError(f"severity: {', '.join(sorted(QA_SEVERITIES))}")


def _parse_attachments(raw: Any) -> List[str]:
    """Достаёт список имён файлов из JSONB / строки / редких несовместимых форм."""
    if raw is None:
        return []
    if isinstance(raw, (bytes, bytearray, memoryview)):
        try:
            raw = bytes(raw).decode("utf-8")
        except Exception:
            return []
    if isinstance(raw, list):
        out = [str(x).strip() for x in raw if x is not None and str(x).strip()]
        return out
    if isinstance(raw, dict):
        nested = raw.get("files") or raw.get("names") or raw.get("attachments")
        if isinstance(nested, list):
            return _parse_attachments(nested)
        keys = list(raw.keys())
        if keys and all(str(k).isdigit() for k in keys):
            ordered = sorted(keys, key=lambda x: int(str(x)))
            return [str(raw[k]).strip() for k in ordered if raw[k] is not None and str(raw[k]).strip()]
        return [str(v).strip() for v in raw.values() if v is not None and str(v).strip()]
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            data = json.loads(s)
        except json.JSONDecodeError:
            return []
        return _parse_attachments(data)
    return []


def _row_to_dict(row: tuple, include_group: bool) -> Dict[str, Any]:
    (
        bid,
        reporter_id,
        reporter_username,
        reporter_group_id,
        area,
        finding_type,
        severity,
        title,
        steps,
        attachments_raw,
        attachment_url_legacy,
        status,
        admin_note,
        created_at,
        updated_at,
    ) = row
    desc = (steps or "").strip() or (title or "").strip()
    names = _parse_attachments(attachments_raw)
    if not names and attachment_url_legacy:
        legacy = str(attachment_url_legacy).strip().rstrip("/").split("/")[-1]
        if legacy and _QA_STORED_FILENAME.match(legacy):
            names = [legacy]
    names = list(dict.fromkeys(names))
    out: Dict[str, Any] = {
        "id": bid,
        "reporter_id": reporter_id,
        "reporter_username": reporter_username,
        "area": area,
        "finding_type": finding_type,
        "severity": severity,
        "description": desc,
        "attachments": [{"name": n, "url": f"/api/qa/files/{n}"} for n in names],
        "status": status,
        "admin_note": admin_note,
        "created_at": created_at.isoformat() if created_at else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }
    if include_group:
        out["reporter_group_id"] = reporter_group_id
    return out


def create_bug(reporter: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    """Создать замечание от имени reporter (JWT user)."""
    description = (data.get("description") or "").strip()
    if len(description) < 3:
        raise ValueError("Описание — не короче 3 символов")

    filenames = data.get("attachment_filenames") or []
    if not isinstance(filenames, list):
        raise ValueError("Некорректные вложения")
    if len(filenames) > 5:
        raise ValueError("Не более 5 файлов")

    rid = int(reporter["id"])
    gid = reporter.get("group_id")
    gid_val = int(gid) if gid is not None else None

    title_db = description[:500]
    steps_db = description

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO qa_bug_report (
                  reporter_id, reporter_group_id, area, finding_type, severity, title,
                  steps, expected_text, actual_text, environment,
                  case_code, session_external_id, attachment_url, attachments_json, status
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s, '', '', '', NULL, NULL, NULL, %s, 'new'
                )
                RETURNING id
                """,
                (
                    rid,
                    gid_val,
                    data["area"],
                    data["finding_type"],
                    data["severity"],
                    title_db,
                    steps_db,
                    Json(filenames),
                ),
            )
            new_id = cur.fetchone()[0]

    bugs = list_bugs_for_viewer(reporter, bug_id=new_id)
    return bugs[0] if bugs else {}


def list_bugs_for_viewer(viewer: Dict[str, Any], bug_id: Optional[int] = None) -> List[Dict[str, Any]]:
    """
    Список замечаний:
    - группа «ЛабЛигалТех» (доступ к QA-трекеру) или роль admin/superuser — все с тем же reporter_group_id;
    - иначе — только свои (reporter_id = viewer).
    """
    role = viewer.get("role") or "user"
    vid = int(viewer["id"])
    include_group = role in ("superuser", "admin")

    base_sql = """
        SELECT b.id, b.reporter_id, u.username, b.reporter_group_id, b.area, b.finding_type,
               b.severity, b.title, b.steps, b.attachments_json, b.attachment_url,
               b.status, b.admin_note,
               b.created_at, b.updated_at
        FROM qa_bug_report b
        JOIN "user" u ON u.id = b.reporter_id
        WHERE 1=1
    """
    params: List[Any] = []

    if bug_id is not None:
        base_sql += " AND b.id = %s"
        params.append(bug_id)

    vgid = viewer.get("group_id")
    scoped_by_group = bool(vgid) and (
        user_can_access_qa_tracker(viewer) or role in ("superuser", "admin")
    )
    if scoped_by_group:
        base_sql += " AND b.reporter_group_id = %s"
        params.append(int(vgid))
    else:
        base_sql += " AND b.reporter_id = %s"
        params.append(vid)

    base_sql += " ORDER BY b.created_at DESC"

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(base_sql, params)
            rows = cur.fetchall()

    return [_row_to_dict(r, include_group) for r in rows]


def get_bug_for_viewer(viewer: Dict[str, Any], bug_id: int) -> Optional[Dict[str, Any]]:
    rows = list_bugs_for_viewer(viewer, bug_id=bug_id)
    return rows[0] if rows else None


def update_bug_admin(
    viewer: Dict[str, Any],
    bug_id: int,
    status: Optional[str] = None,
    admin_note: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Обновить статус/заметку методиста. Админы, superuser или все участники группы «ЛабЛигалТех» (как у доступа к QA)."""
    role = viewer.get("role") or "user"
    if role not in ("admin", "superuser") and not user_can_access_qa_tracker(viewer):
        return None

    existing = get_bug_for_viewer(viewer, bug_id)
    if not existing:
        return None

    if status is not None and status not in QA_STATUSES:
        raise ValueError("Недопустимый status")
    if status is None and admin_note is None:
        return existing

    sets: List[str] = []
    params: List[Any] = []
    if status is not None:
        sets.append("status = %s")
        params.append(status)
    if admin_note is not None:
        sets.append("admin_note = %s")
        params.append(admin_note)
    sets.append("updated_at = NOW()")
    params.append(bug_id)

    sql = f"UPDATE qa_bug_report SET {', '.join(sets)} WHERE id = %s"

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)

    return get_bug_for_viewer(viewer, bug_id)


def delete_bug_for_viewer(viewer: Dict[str, Any], bug_id: int) -> bool:
    """
    Удалить замечание, если оно доступно текущему пользователю (как при просмотре).
    Файлы вложений удаляются с диска после успешного DELETE в БД.
    """
    existing = get_bug_for_viewer(viewer, bug_id)
    if not existing:
        return False

    names: List[str] = []
    for a in existing.get("attachments") or []:
        if isinstance(a, dict) and a.get("name"):
            names.append(str(a["name"]))

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM qa_bug_report WHERE id = %s", (bug_id,))
            if cur.rowcount == 0:
                return False

    for n in names:
        try:
            p = QA_UPLOAD_DIR / n
            if p.is_file():
                p.unlink()
        except OSError:
            pass
    return True
