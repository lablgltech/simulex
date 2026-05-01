"""
Роутер авторизации: вход (login), текущий пользователь (me).
Регистрация обычных пользователей — через админку; исключение: /register-vkr по промо-коду.
"""
import logging
import os
import secrets
from typing import Any, Dict, List, Tuple

import psycopg2
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, field_validator

from services.auth_service import (
    create_access_token,
    create_user,
    decode_token,
    get_or_create_group_id_by_name,
    get_user_by_id,
    get_user_by_username,
    verify_password,
)

log = logging.getLogger(__name__)

# Группа для зачислений по промо: имя в user_group (создаётся при отсутствии).
_VKR_GROUP_NAME = (os.environ.get("VKR_GROUP_NAME") or "vkr").strip() or "vkr"
# Промо-код по умолчанию; в проде можно задать VKR_PROMO_CODE.
_DEFAULT_PROMO = "ВКР2026"
_VKR_PROMO_CODE = (os.environ.get("VKR_PROMO_CODE") or _DEFAULT_PROMO).strip()


def _vkr_register_disabled() -> bool:
    v = (os.environ.get("VKR_PROMO_REGISTER_DISABLED") or "").strip().lower()
    return v in ("1", "true", "yes", "on", "да")


def _gen_vkr_username_and_password() -> Tuple[str, str]:
    """Простые креды: логин vkr_ + 6 цифр, пароль — 6 цифр (легко записать и ввести)."""
    n_user = secrets.randbelow(1_000_000)
    n_pass = secrets.randbelow(1_000_000)
    return f"vkr_{n_user:06d}", f"{n_pass:06d}"

router = APIRouter(prefix="/api/auth", tags=["auth"])
security = HTTPBearer(auto_error=False)


def _truncate_password_72_bytes(v: str) -> str:
    """Ограничение bcrypt: не более 72 байт (UTF-8)."""
    if not v or len(v.encode("utf-8")) <= 72:
        return v
    return v.encode("utf-8")[:72].decode("utf-8", errors="ignore")


class LoginRequest(BaseModel):
    username: str
    password: str

    @field_validator("password")
    @classmethod
    def truncate_password(cls, v: str) -> str:
        return _truncate_password_72_bytes(v)


class VkrRegisterRequest(BaseModel):
    promo_code: str


def get_current_user_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Dict[str, Any] | None:
    """
    Извлечь текущего пользователя из JWT, если токен передан и валиден.
    Если токена нет или он невалиден — возвращает None.
    """
    token = None
    if credentials and credentials.credentials:
        token = credentials.credentials
    if not token:
        return None
    payload = decode_token(token)
    if not payload or "sub" not in payload:
        return None
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        return None
    user = get_user_by_id(user_id)
    if not user:
        return None
    return user


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Dict[str, Any]:
    """Требует валидный JWT. Иначе 401."""
    user = get_current_user_optional(request, credentials)
    if not user:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    return user


def require_roles(allowed_roles: List[str]):
    """Зависимость: пользователь должен иметь одну из ролей."""

    async def _require(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if current_user.get("role") not in allowed_roles:
            raise HTTPException(status_code=403, detail="Недостаточно прав")
        return current_user

    return _require


@router.post("/login")
async def login(body: LoginRequest) -> Dict[str, Any]:
    """
    Вход по username и password. Возвращает access_token и данные пользователя.
    """
    try:
        user = get_user_by_username(body.username)
    except psycopg2.Error as e:
        # OperationalError и другие ошибки драйвера (аутентификация, нет схемы и т.д.)
        # — иначе глобальный handler отдаёт 500 с сырым текстом исключения.
        raise HTTPException(
            status_code=503,
            detail="База данных недоступна. Проверьте backend/.env (POSTGRES_DSN), что PostgreSQL запущен и выполнены миграции: python run_migrations.py",
        ) from e
    if not user:
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    try:
        if not verify_password(body.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    except (ValueError, TypeError):
        # bcrypt 4.x и др. могут выбросить при неверном формате/длине пароля
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = create_access_token(data={"sub": str(user["id"]), "role": user["role"]})
    out = {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": user["role"],
            "group_id": user.get("group_id"),
            "group_name": user.get("group_name") or "",
        },
    }
    return out


@router.get("/me", response_model=Dict[str, Any])
async def me(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """Текущий авторизованный пользователь."""
    return current_user


@router.post("/register-vkr")
async def register_vkr(body: VkrRegisterRequest) -> Dict[str, Any]:
    """
    Регистрация участника с ролью user в группе (по умолчанию vkr) по верному промо-коду.
    Пароль генерируется; JWT не выдаётся — войти нужно вручную, сохранив логин и пароль.
    """
    if _vkr_register_disabled():
        raise HTTPException(status_code=403, detail="Регистрация по промо-коду сейчас отключена")

    code = (body.promo_code or "").strip()
    if code != _VKR_PROMO_CODE:
        raise HTTPException(status_code=400, detail="Неверный промо-код")

    try:
        group_id = get_or_create_group_id_by_name(_VKR_GROUP_NAME)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except psycopg2.Error as e:
        log.exception("register-vkr: не удалось получить группу %s", _VKR_GROUP_NAME)
        raise HTTPException(
            status_code=503,
            detail="База данных недоступна. Проверьте POSTGRES_DSN и миграции.",
        ) from e

    last_err: Exception | None = None
    for _attempt in range(32):
        username, password = _gen_vkr_username_and_password()
        try:
            u = create_user(
                username=username,
                password=password,
                role="user",
                email=None,
                group_id=group_id,
            )
        except ValueError as e:
            log.exception("register-vkr: неожиданная валидация")
            raise HTTPException(status_code=500, detail=str(e)) from e
        except psycopg2.IntegrityError as e:
            last_err = e
            if getattr(e, "pgcode", None) == "23505":
                continue
            log.exception("register-vkr: ошибка вставки пользователя")
            raise HTTPException(
                status_code=503,
                detail="Ошибка при создании учётной записи. Повторите позже.",
            ) from e
        except psycopg2.Error as e:
            log.exception("register-vkr: БД")
            raise HTTPException(
                status_code=503,
                detail="База данных недоступна. Проверьте POSTGRES_DSN и миграции.",
            ) from e
        else:
            log.info(
                "vkr promo registration: user id=%s username=%s group=%s",
                u.get("id"),
                u.get("username"),
                _VKR_GROUP_NAME,
            )
            return {
                "username": u["username"],
                "password": password,
                "user": {
                    "id": u["id"],
                    "username": u["username"],
                    "email": u.get("email") or "",
                    "role": u["role"],
                    "group_id": u.get("group_id"),
                    "group_name": u.get("group_name") or "",
                },
                "message": "Сохраните логин и пароль в надёжном месте. Восстановить выданный пароль через эту форму нельзя — при утере обратитесь к администратору.",
            }
    if last_err:
        log.error("register-vkr: исчерпаны попытки: %s", last_err)
    raise HTTPException(
        status_code=503,
        detail="Не удалось создать уникальную учётную запись. Попробуйте снова через минуту.",
    )
