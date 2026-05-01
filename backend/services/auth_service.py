"""
Сервис авторизации: пользователи, JWT, пароли.
Роли: superuser, admin, user.
Группы (user_group): админ видит отчёты и дашборд только по участникам своей группы.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

from db import get_connection

                              
ALGORITHM = "HS256"
                                                                                                          
try:
    ACCESS_TOKEN_EXPIRE_MINUTES = int(
        (os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES") or str(60 * 48)).strip() or str(60 * 48)
    )
except (TypeError, ValueError):
    ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 48
if ACCESS_TOKEN_EXPIRE_MINUTES < 1:
    ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 48

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

                                                                       
BCRYPT_MAX_BYTES = 72


def _truncate_password_for_bcrypt(password: str) -> str:
    """Обрезает пароль до 72 байт (ограничение bcrypt)."""
    if not password:
        return password
    encoded = password.encode("utf-8")
    if len(encoded) <= BCRYPT_MAX_BYTES:
        return password
    return encoded[:BCRYPT_MAX_BYTES].decode("utf-8", errors="ignore")


def get_jwt_secret() -> str:
    """Секрет для подписи JWT из переменной окружения."""
    secret = os.environ.get("JWT_SECRET", "").strip()
    if not secret:
                                                               
        secret = "dev-secret-change-in-production"
    return secret


def hash_password(password: str) -> str:
    return pwd_context.hash(_truncate_password_for_bcrypt(password))


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(_truncate_password_for_bcrypt(plain), hashed)


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, get_jwt_secret(), algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        return jwt.decode(token, get_jwt_secret(), algorithms=[ALGORITHM])
    except JWTError:
        return None


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    """Получить пользователя по id."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id, u.username, u.email, u.role, u.created_at, u.group_id, g.name
                FROM "user" u
                LEFT JOIN user_group g ON g.id = u.group_id
                WHERE u.id = %s
                """,
                (user_id,),
            )
            row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "username": row[1],
        "email": row[2] or "",
        "role": row[3],
        "created_at": row[4].isoformat() if row[4] else None,
        "group_id": row[5],
        "group_name": row[6] or "",
    }


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    """Получить пользователя по username (для входа)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id, u.username, u.email, u.password_hash, u.role, u.created_at, u.group_id, g.name
                FROM "user" u
                LEFT JOIN user_group g ON g.id = u.group_id
                WHERE u.username = %s
                """,
                (username.strip().lower(),),
            )
            row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "username": row[1],
        "email": row[2] or "",
        "password_hash": row[3],
        "role": row[4],
        "created_at": row[5].isoformat() if row[5] else None,
        "group_id": row[6],
        "group_name": row[7] or "",
    }


def group_exists(group_id: int) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM user_group WHERE id = %s", (group_id,))
            return cur.fetchone() is not None


def get_group_id_by_exact_name(name: str) -> Optional[int]:
    """id группы по точному совпадению name (без нормализации)."""
    n = (name or "").strip()
    if not n:
        return None
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM user_group WHERE name = %s", (n,))
            row = cur.fetchone()
    return int(row[0]) if row else None


def get_or_create_group_id_by_name(name: str) -> int:
    """Вернуть id группы с заданным именем; при отсутствии — создать."""
    n = (name or "").strip()
    if not n:
        raise ValueError("Название группы обязательно")
    existing = get_group_id_by_exact_name(n)
    if existing is not None:
        return existing
    g = create_group(n)
    return int(g["id"])


def list_groups() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, created_at FROM user_group ORDER BY name
                """
            )
            rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "name": r[1],
            "created_at": r[2].isoformat() if r[2] else None,
        }
        for r in rows
    ]


def create_group(name: str) -> Dict[str, Any]:
    n = (name or "").strip()
    if not n:
        raise ValueError("Название группы обязательно")
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO user_group (name) VALUES (%s)
                RETURNING id, name, created_at
                """,
                (n,),
            )
            row = cur.fetchone()
    return {
        "id": row[0],
        "name": row[1],
        "created_at": row[2].isoformat() if row[2] else None,
    }


def participant_user_ids_for_group(group_id: int) -> List[int]:
    """Участники (роль user) в группе — по их сессиям и отчётам видит админ."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id FROM "user"
                WHERE group_id = %s AND role = 'user'
                ORDER BY id
                """,
                (group_id,),
            )
            return [r[0] for r in cur.fetchall()]


def participant_user_ids_visible_to_viewer(viewer: Optional[Dict[str, Any]]) -> Optional[List[int]]:
    """
    Список user_id участников для фильтрации сессий/отчётов.
    None — без ограничения (суперюзер или админ-API без JWT).
    [] — админ без группы: пустая выборка.
    """
    if viewer is None:
        return None
    if viewer.get("role") == "superuser":
        return None
    if viewer.get("role") != "admin":
        return None
    gid = viewer.get("group_id")
    if not gid:
        return []
    return participant_user_ids_for_group(int(gid))


def create_user(
    username: str,
    password: str,
    role: str = "user",
    email: Optional[str] = None,
    group_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Создать пользователя. Роль: superuser, admin, user. group_id — опционально (для admin/user)."""
    if role not in ("superuser", "admin", "user"):
        raise ValueError("Роль должна быть: superuser, admin, user")
    username_clean = username.strip().lower()
    if not username_clean:
        raise ValueError("Имя пользователя обязательно")
    if not password or len(password) < 4:
        raise ValueError("Пароль не менее 4 символов")

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "user" (username, email, password_hash, role, group_id)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, username, email, role, created_at, group_id
                """,
                (
                    username_clean,
                    (email or "").strip() or None,
                    hash_password(password),
                    role,
                    group_id,
                ),
            )
            row = cur.fetchone()
            gname = ""
            if row[5] is not None:
                cur.execute("SELECT name FROM user_group WHERE id = %s", (row[5],))
                gr = cur.fetchone()
                gname = (gr[0] or "") if gr else ""
    return {
        "id": row[0],
        "username": row[1],
        "email": row[2] or "",
        "role": row[3],
        "created_at": row[4].isoformat() if row[4] else None,
        "group_id": row[5],
        "group_name": gname,
    }


def update_user_password(username: str, new_password: str) -> bool:
    """Обновить пароль пользователя по username. Возвращает True, если пользователь найден и пароль обновлён."""
    if not new_password or len(new_password) < 4:
        raise ValueError("Пароль не менее 4 символов")
    username_clean = username.strip().lower()
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "user"
                SET password_hash = %s, updated_at = NOW()
                WHERE username = %s
                """,
                (hash_password(new_password), username_clean),
            )
            return cur.rowcount > 0


def list_users_for_panel(viewer: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Список для админки: суперюзер — все; админ — только своя группа (роли admin и user).
    viewer=None (API-ключ) — как суперюзер, все пользователи.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            if viewer is None or viewer.get("role") == "superuser":
                cur.execute(
                    """
                    SELECT u.id, u.username, u.email, u.role, u.created_at, u.group_id, g.name
                    FROM "user" u
                    LEFT JOIN user_group g ON g.id = u.group_id
                    ORDER BY u.role, u.username
                    """
                )
            else:
                gid = viewer.get("group_id")
                if not gid:
                    return []
                cur.execute(
                    """
                    SELECT u.id, u.username, u.email, u.role, u.created_at, u.group_id, g.name
                    FROM "user" u
                    LEFT JOIN user_group g ON g.id = u.group_id
                    WHERE u.group_id = %s AND u.role IN ('admin', 'user')
                    ORDER BY u.role, u.username
                    """,
                    (gid,),
                )
            rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "username": r[1],
            "email": r[2] or "",
            "role": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
            "group_id": r[5],
            "group_name": r[6] or "",
        }
        for r in rows
    ]


def delete_user(user_id: int) -> bool:
    """Удалить пользователя по id. Возвращает True если удалён."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM "user" WHERE id = %s', (user_id,))
            return cur.rowcount > 0
