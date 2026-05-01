# Simulex Platform

**Данная версия** предоставляется для **демонстрации базовой функциональности** сервиса: тот же стек (**React** + **FastAPI** + **PostgreSQL**), рабочие вход, сессии и цепочка «этап → отчёт». В этой поставке сделан упор на понятный минимальный сценарий: демонстрационный кейс из одного этапа, интерфейс **Симуграма** и шкала **LEXIC** в игровом UI отключены (флаг `PLATFORM_SHELL` в `src/config/platformShell.js`), учебный контент в `data/cases/` в репозиторий не включён — его можно добавить при развёртывании полной конфигурации. Исходники по-прежнему содержат модули расширенного продукта (этапы 1–4, отчёты, админка) для дальнейшего развития.

Публичный репозиторий: [https://github.com/lablgltech/simulex](https://github.com/lablgltech/simulex).

---

## Что внутри

| Компонент | Содержимое |
|-----------|------------|
| **Frontend** | Create React App, экран входа, выбор кейса, прохождение этапа через `GenericStageView`, отчёт (при завершении сценария). В демонстрационной конфигурации Симуграм не показывается (`PLATFORM_SHELL` в `src/config/platformShell.js`). |
| **Backend** | FastAPI, JWT-авторизация, сессии, синхронизация кейсов из `data/case*.json` в БД при старте. |
| **Данные** | Файл `data/case.json` — демонстрационный кейс `shell` (тип этапа `shell`). Расширенные сценарии и файлы в `data/cases/<id>/` подключаются при необходимости отдельно. |
| **Документация** | Этот README и [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md). |

---

## Требования

- **Node.js** 18+ и npm  
- **Python** 3.10+ (рекомендуется та же мажорная версия, что и в проде)  
- **PostgreSQL** (локально или Docker)

---

## Быстрый старт

### 1. Зависимости фронтенда

```bash
npm install
```

В репозитории есть `.npmrc` с `legacy-peer-deps=true` (совместимость `react-scripts` 5 с TypeScript 6).

### 2. База данных и бэкенд

```bash
cd backend
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

В **`backend/.env`** обязательно задайте:

- `POSTGRES_DSN` — строка подключения к PostgreSQL.  
- Для первого запуска без продакшен-секретов раскомментируйте **`DEBUG=true`** в `.env` (иначе процесс завершится с требованием `JWT_SECRET`).  
- На проде: **`JWT_SECRET`**, `DEBUG=false`.

Примените миграции и создайте пользователя:

```bash
python3 run_migrations.py
python3 create_superuser.py
```

По умолчанию суперпользователь: логин `super`, пароль `super` (смените после входа).

### 3. Запуск в режиме разработки

Из **корня** репозитория:

```bash
npm run dev
```

Поднимается фронтенд на порту **3000** (с прокси на API) и бэкенд на **5000**. Откройте [http://127.0.0.1:3000](http://127.0.0.1:3000), войдите, выберите демонстрационный кейс, выполните действие на этапе и завершите этап — проверится цепочка сессии и генерация отчёта.

Отдельно: `npm run client:dev` и `npm run backend:dev`.

### 4. Сборка фронтенда

```bash
npm run build
```

Статика окажется в каталоге `build/`.

---

## Переменные окружения (кратко)

| Переменная | Назначение |
|------------|------------|
| `POSTGRES_DSN` | Подключение к PostgreSQL |
| `DEBUG` | `true` — упрощённый локальный режим (см. `backend/.env.example`) |
| `JWT_SECRET` | Обязателен при `DEBUG=false` |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Для ИИ-функций отчёта и наставника (опционально в базовой демонстрации) |

Подробности — в `backend/.env.example` и в [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md).

---

## Структура каталогов (сокращённо)

```
backend/           # FastAPI: main.py, routers/, services/, миграции
src/               # React: pages/, components/, stages/StageRegistry.js
data/              # case.json и др.; контент кейсов — в data/cases/<id>/ (по желанию)
scripts/           # Вспомогательные скрипты запуска бэкенда
deploy/            # Пример nginx (часть файлов в .gitignore — см. .gitignore)
```

---

## Публикация на GitHub

```bash
git remote add origin https://github.com/lablgltech/simulex.git
git branch -M main
git push -u origin main
```

Перед пушем убедитесь, что в репозиторий не попал `backend/.env` (он в `.gitignore`).

---

## Лицензия

ПО распространяется на условиях **проприетарной лицензии**: без письменного разрешения правообладателя запрещены **изменение исходного кода** и **коммерческое использование**. Полный текст — в файле [LICENSE](LICENSE). Правообладатель: Lab Legal Tech.
