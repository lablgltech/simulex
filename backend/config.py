"""
Конфигурация приложения.

Здесь же подключается поддержка .env-файла, чтобы локально
не прописывать ключи (например, OPENAI_API_KEY) в коде.
"""

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional


def _load_dotenv() -> None:
  """
  Простейший загрузчик .env без сторонних зависимостей.

  Ищет файлы:
  - <repo_root>/.env
  - <repo_root>/backend/.env

  и устанавливает переменные окружения, если они ещё не заданы.
  Формат строк: KEY=VALUE, строки с # игнорируются.
  """
  base_dir = Path(__file__).parent.parent
  # Сначала backend/.env, чтобы пароль БД и т.п. точно подхватывались
  candidates = [base_dir / "backend" / ".env", base_dir / ".env"]
  _root_dotenv = (base_dir / ".env").resolve()

  for env_path in candidates:
    if not env_path.exists():
      continue
    try:
      with env_path.open("r", encoding="utf-8") as f:
        for line in f:
          line = line.strip()
          if not line or line.startswith("#"):
            continue
          if "=" not in line:
            continue
          key, value = line.split("=", 1)
          key = key.strip()
          value = value.strip().strip('"').strip("'").strip()
          if " #" in value:
            value = value.split(" #", 1)[0].rstrip()
          # В корне PORT=3000 — порт React (CRA); не подставлять как порт FastAPI (прокси: src/setupProxy.js → :5000).
          if key == "PORT" and env_path.resolve() == _root_dotenv:
            continue
          # Подставляем значение, если ключа нет или он пустой (чтобы .env перезаписывал пустой POSTGRES_DSN)
          if key and (key not in os.environ or not (os.environ.get(key) or "").strip()):
            os.environ[key] = value
    except OSError:
      # Тихо игнорируем проблемы чтения локального .env
      pass


# Загружаем .env до чтения переменных окружения
_load_dotenv()

# Путь к директории с данными
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"

# База знаний (админка, генерация кейсов). По умолчанию data/kb
_KB_DIR_ENV = os.getenv("KB_DIR", "").strip()
KB_DIR = Path(_KB_DIR_ENV).resolve() if _KB_DIR_ENV else (DATA_DIR / "kb")

# Порт сервера
PORT = int(os.getenv("PORT", 5000))

# Настройки
DEBUG = os.getenv("DEBUG", "false").lower() == "true"


def env_truthy(name: str, *, default: bool = False) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on", "да")


def reseed_cases_on_startup() -> bool:
    """
    Синхронизация каталога кейсов с БД при старте процесса API.
    Если переменная не задана — True (как раньше). На проде с общей БД и разным диском задайте 0.
    """
    raw = os.getenv("RESEED_CASES_ON_STARTUP")
    if raw is None or not str(raw).strip():
        return True
    return env_truthy("RESEED_CASES_ON_STARTUP", default=False)

# --- Пороги участия для начисления LEXIC (слияние: JSON поверх дефолтов) ---
_LEXIC_PARTICIPATION_FALLBACK: Dict[str, Any] = {
    "stage1": {
        "empty_max_conclusion_len": 40,
        "token_max_bad_questions": 2,
        "token_min_insights": 2,
        "token_max_conclusion_len": 60,
        "min_good_medium_straight": 2,
        "combo_min_good_medium": 1,
        "combo_min_insights": 2,
        "combo_min_conclusion_len": 80,
        "heavy_min_insights": 4,
        "heavy_min_good_medium": 1,
    },
    "stage2": {
        "score_floor_pct": 12.0,
        "min_found_ratio_of_total": 0.12,
        "min_found_absolute_floor": 2,
        "token_max_found_risks": 1,
        "token_max_score_pct": 22.0,
    },
    "stage3": {
        "min_player_turns": 3,
    },
    "stage4": {
        "min_diagnosis_answers": 3,
    },
}

_LEXIC_PARTICIPATION_CACHE: Optional[Dict[str, Any]] = None


def _deep_merge_dict(base: Dict[str, Any], over: Dict[str, Any]) -> None:
    for k, v in over.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge_dict(base[k], v)
        else:
            base[k] = v


def _load_lexic_participation_merged() -> Dict[str, Any]:
    cfg = copy.deepcopy(_LEXIC_PARTICIPATION_FALLBACK)
    path_env = os.getenv("LEXIC_PARTICIPATION_CONFIG_PATH", "").strip()
    default_path = Path(__file__).parent / "config" / "lexic_participation.json"
    path = Path(path_env) if path_env else default_path
    if not path.is_file():
        return cfg
    try:
        with path.open("r", encoding="utf-8") as f:
            user = json.load(f)
        if isinstance(user, dict):
            _deep_merge_dict(cfg, user)
    except (OSError, json.JSONDecodeError) as e:
        print(f"⚠️ config: не удалось загрузить {path}: {e}")
    return cfg


def get_lexic_participation_config() -> Dict[str, Any]:
    """Пороги LEXIC по этапам (кэш на процесс). Файл: backend/config/lexic_participation.json."""
    global _LEXIC_PARTICIPATION_CACHE
    if _LEXIC_PARTICIPATION_CACHE is None:
        _LEXIC_PARTICIPATION_CACHE = _load_lexic_participation_merged()
    return _LEXIC_PARTICIPATION_CACHE


def reload_lexic_participation_config() -> None:
    """Сброс кэша (тесты или смена файла без перезапуска)."""
    global _LEXIC_PARTICIPATION_CACHE
    _LEXIC_PARTICIPATION_CACHE = None


def redis_url() -> str:
    """URL Redis для кэша/блокировок; пустая строка — Redis отключён."""
    return (os.getenv("REDIS_URL") or "").strip()


def case_content_redis_ttl_seconds() -> int:
    raw = (os.getenv("CASE_CONTENT_REDIS_TTL_SECONDS") or "").strip()
    if not raw:
        return 300
    try:
        return max(30, min(86400, int(raw)))
    except ValueError:
        return 300


def get_case_from_filesystem_env() -> bool:
    """Если true — get_case по умолчанию читает с диска (как раньше), без case_content_json."""
    return env_truthy("GET_CASE_FROM_FILESYSTEM", default=False)
