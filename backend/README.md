# Backend - FastAPI + PostgreSQL

Бекенд для Симулекс написан на Python с использованием FastAPI и PostgreSQL для хранения состояния.

## Установка

```bash
cd backend

# Создать виртуальное окружение (рекомендуется)
python3 -m venv venv
source venv/bin/activate  # Linux/Mac
# или
venv\Scripts\activate  # Windows

# Установить зависимости
pip install -r requirements.txt
```

## Настройка БД (PostgreSQL)

- Убедитесь, что установлен и запущен PostgreSQL.
- Создайте файл **`backend/.env`** (скопируйте из `.env.example`) и задайте:
  ```
  POSTGRES_DSN=postgresql://user:password@localhost:5432/simulex
  ```
  DSN загружается из `.env` при старте приложения (`main.py`), поэтому **запускайте uvicorn из папки `backend`**.
- Без `.env` используется дефолт `postgresql://localhost:5432/simulex` (без логина/пароля — возможна ошибка аутентификации).
- **JWT_SECRET** обязателен на проде при `DEBUG=false`. Локально без секрета раскомментируйте **`DEBUG=true`** в `backend/.env` (см. `.env.example`), иначе `main.py` завершится с FATAL при старте.

### Миграции (создание схемы)

Перед первым запуском выполните SQL‑миграции:

```bash
cd backend
python3 run_migrations.py
```

Скрипт:
- при необходимости создаст базу `simulex`;
- применит по очереди **`migrations.sql`** и файлы из списка **`MIGRATION_SQL_FILES`** в `run_migrations.py` (сейчас это в т. ч. `migrations_ai_global_lessons.sql`, `migrations_admin_autoplay_job.sql`, `migrations_case_content_json.sql`) — таблица `user`, `game_session.user_id`, `ai_global_lessons`, очередь autoplay, колонки материализованного контента кейса и т. д.

### Первый суперпользователь

После миграций создайте учётную запись для входа и админки:

```bash
cd backend
python create_superuser.py
```

По умолчанию: логин **super**, пароль **super**, роль **superuser**. Другие пользователи создаются через админку (вкладка «Пользователи») или так:

```bash
python create_superuser.py --username admin --password secret --role admin
python create_superuser.py --username student --password pass --role user
```

## Запуск

### Режим разработки

Запуск **из папки backend** (чтобы подхватился `.env`):

```bash
cd backend

# С автоматической перезагрузкой
python -m uvicorn main:app --reload --host 127.0.0.1 --port 5000

# Или через Python
python main.py
```

На Windows stdout/stderr принудительно переключаются на UTF-8 (в `main.py`), чтобы избежать ошибок при выводе Unicode и эмодзи в консоль.

После старта:
- `main.py` настраивает CORS;
- вызывает `seed_cases_and_resources_on_startup(DATA_DIR)`, который:
  - читает все `data/case*.json`;
  - upsert-ит записи в таблицу `case`;
  - через `seed_contract_for_case` синхронизирует таблицу `contract` с ресурсами (`data/cases/.../stage-3/...`);
- подключает платформенные роутеры (`auth`, `admin`, `cases`, `sessions`, `actions`, `stages`, `reports`, `tutor`);
- подключает дополнительные роутеры этапов через реестр `STAGE_EXTRA_ROUTERS` (см. `backend/stages/__init__.py` и `backend/stages/stage_3.py`).

## Авторизация (Auth)

- **Роли:** `superuser`, `admin`, `user`. Суперюзер видит всё и управляет всеми пользователями; админ — кейсы/KB/дашборд и только пользователей с ролью `user`; юзер — только игру и свои отчёты.
- **API:** `POST /api/auth/login` (логин/пароль → JWT и данные пользователя), `GET /api/auth/me` (текущий пользователь по заголовку `Authorization: Bearer <token>`).
- **Админка:** доступ по JWT с ролью admin/superuser или по заголовку `X-Admin-Key` (для обратной совместимости). Управление пользователями: `GET /api/admin/users`, `POST /api/admin/users`, `DELETE /api/admin/users/{id}`.
- **Сессии и отчёты:** при авторизованном `POST /api/session/start` сессия привязывается к `user_id`. Личный кабинет: `GET /api/report/my-sessions`, `GET /api/session/{id}` (только свои сессии).
- Сервисы: `services/auth_service.py` (JWT, bcrypt, CRUD пользователей), роутер `routers/auth.py`, зависимости `get_current_user` / `get_current_user_optional` / `require_roles`.

### Продакшен

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 5000
```

## API документация

После запуска доступны:
- Swagger UI: `http://127.0.0.1:5000/docs`
- ReDoc: `http://127.0.0.1:5000/redoc`

## Проверка подключения к БД

Из папки `backend` можно запустить тест:
```bash
python test_db.py
```
Пошаговая диагностика (чтение .env, подключение, запрос кейсов, эмуляция uvicorn): `python test_db_steps.py`.

## Структура (упрощённо)

- `main.py` — точка входа FastAPI, загрузка `POSTGRES_DSN` из `.env`, CORS, сидирование кейсов/ресурсов, подключение роутеров;
- `db.py` — подключение к PostgreSQL (DSN из `.env` или чтение из `backend/.env`, иначе дефолтный DSN);
- `run_migrations.py` — базовая схема (`migrations.sql`) и дополнительные `migrations_*.sql`, создание БД;
- `routers/` — HTTP‑эндпойнты (auth, admin в т.ч. users, кейсы, сессии, действия, этапы, отчёты, тьютор, документ и чат этапа 3);
- `services/` — бизнес‑логика (auth: JWT, пользователи; кейсы, сессии, этапы, отчёты, тьютор, переговоры, ИИ);
- `create_superuser.py` — создание первого суперпользователя или пользователя с заданной ролью;
- `stages/` — базовый класс этапа и реализации `stage_1`–`stage_4`;
- `utils/` — утилиты (загрузка файлов, валидаторы).
