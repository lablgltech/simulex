"""
Утилиты для загрузки файлов с кейсами.

ИЗМЕНЕНИЯ ДЛЯ ЭТАПА 1 (внесены в обход CONTRIBUTING: файл в зоне ответственности Леши):
- load_document_markdown(), enrich_stage1_documents_from_markdown() — загрузка контента
  документов этапа 1 из data/cases/case-XXX/stages/stage1/{doc_id}.md, т.к. в case.json
  у документов нет поля content (контент хранится в .md). Stage1View отображает doc.content.
- Во всех ветках load_case_data после enrich_case_with_markdown вызывается
  enrich_stage1_documents_from_markdown, в т.ч. в ветке по умолчанию (загрузка без case_id),
  чтобы контент документов подставлялся при любом пути загрузки.
"""
import json
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)


def load_case_data(data_dir: Path, case_id: Optional[str] = None) -> Dict[str, Any]:
    """Загрузить данные кейса"""
    logger.debug(f"🔍 load_case_data вызван с case_id: {case_id} (тип: {type(case_id)})")
    if case_id:
        # Убираем префикс "case-" если есть
        clean_case_id = str(case_id).replace("case-", "").strip()
        logger.debug(f"   Очищенный case_id: '{clean_case_id}'")
        
        if clean_case_id == "001" or clean_case_id == "":
            case_file_path = data_dir / "case.json"
            if case_file_path.exists():
                with open(case_file_path, "r", encoding="utf-8") as f:
                    case_data = json.load(f)
                    default_case = case_data.get("case", case_data)
                    logger.debug(f"📂 Загружен дефолтный кейс (case.json): {default_case.get('id')}, этапов: {len(default_case.get('stages', []))}")
                    # Обогащаем этапы Markdown контентом
                    default_case = enrich_case_with_markdown(data_dir, default_case)
                    default_case = enrich_stage1_documents_from_markdown(data_dir, default_case)
                    return default_case
        
        # Пытаемся загрузить case-{id}.json
        case_file_path = data_dir / f"case-{clean_case_id}.json"
        logger.debug(f"📂 Попытка загрузить кейс: {case_file_path} (существует: {case_file_path.exists()})")
        if case_file_path.exists():
            with open(case_file_path, "r", encoding="utf-8") as f:
                case_data = json.load(f)
                loaded_case = case_data.get("case", case_data)
                logger.debug(f"✅ Кейс загружен: {loaded_case.get('id')}, этапов: {len(loaded_case.get('stages', []))}, первый этап: {loaded_case.get('stages', [{}])[0].get('id') if loaded_case.get('stages') else 'нет'}")
                # Обогащаем этапы Markdown контентом
                loaded_case = enrich_case_with_markdown(data_dir, loaded_case)
                loaded_case = enrich_stage1_documents_from_markdown(data_dir, loaded_case)
                return loaded_case
        else:
            logger.debug(f"⚠️ Файл не найден: {case_file_path}, загружаю дефолтный case.json")
            # Список доступных файлов для отладки
            available_files = list(data_dir.glob("case*.json"))
            logger.debug(f"   Доступные файлы: {[f.name for f in available_files]}")
    case_file_path = data_dir / "case.json"
    with open(case_file_path, "r", encoding="utf-8") as f:
        case_data = json.load(f)
        default_case = case_data.get("case", case_data)
        logger.debug(f"📂 Загружен дефолтный кейс: {default_case.get('id')}, этапов: {len(default_case.get('stages', []))}")
        # Обогащаем этапы Markdown контентом и контентом документов этапа 1 (см. комментарий в шапке файла)
        default_case = enrich_case_with_markdown(data_dir, default_case)
        default_case = enrich_stage1_documents_from_markdown(data_dir, default_case)
        return default_case


def load_all_cases(data_dir: Path, published_only: bool = True) -> List[Dict[str, Any]]:
    """Загрузить кейсы из case*.json. По умолчанию только published; при published_only=False — все."""
    cases = []
    for file_path in data_dir.glob("case*.json"):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                case_data = json.load(f)
                case = case_data.get("case", case_data)
                if published_only and case.get("status") != "published":
                    continue
                cases.append(case)
        except Exception as e:
            logger.warning("Ошибка загрузки %s: %s", file_path.name, e)
    return cases


def load_stage_markdown(data_dir: Path, case_id: str, stage_id: str) -> Optional[str]:
    """
    Загрузить Markdown контент для этапа (легенду)
    
    Args:
        data_dir: Путь к директории с данными
        case_id: ID кейса (например, "case-001" или "001")
        stage_id: ID этапа (например, "stage-1")
    
    Returns:
        Содержимое MD файла или None, если файл не найден
    
    Структура: data/cases/case-XXX/stage-X/legend.md
    """
    # Убираем префикс "case-" если есть
    clean_case_id = str(case_id).replace("case-", "").strip()
    
    # Путь к легенде этапа: data/cases/case-XXX/stage-X/legend.md
    legend_file = data_dir / "cases" / f"case-{clean_case_id}" / stage_id / "legend.md"
    
    if legend_file.exists():
        try:
            with open(legend_file, "r", encoding="utf-8") as f:
                content = f.read()
                logger.debug(f"✅ Загружена легенда для {case_id}/{stage_id}: {len(content)} символов")
                return content
        except Exception as e:
            logger.debug(f"⚠️ Ошибка чтения файла легенды {legend_file}: {e}")
            return None
    
    logger.debug(f"ℹ️ Легенда не найдена для {case_id}/{stage_id} (ожидалось: {legend_file})")
    return None


def load_document_markdown(data_dir: Path, case_id: str, doc_id: str) -> Optional[str]:
    """
    Загрузить контент документа этапа 1 из MD файла.
    Путь: data/cases/case-XXX/stage-1/{doc_id}.md
    Добавлено для этапа 1: контент документов хранится в .md, не в case.json (файл в зоне Леши).
    """
    clean_case_id = str(case_id).replace("case-", "").strip()
    doc_file = data_dir / "cases" / f"case-{clean_case_id}" / "stage-1" / f"{doc_id}.md"
    if doc_file.exists():
        try:
            with open(doc_file, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            logger.debug(f"⚠️ Ошибка чтения документа {doc_id}.md: {e}")
    return None


def enrich_case_with_markdown(data_dir: Path, case_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Обогатить данные кейса Markdown контентом для этапов
    
    Args:
        data_dir: Путь к директории с данными
        case_data: Данные кейса
    
    Returns:
        Обогащенные данные кейса
    """
    case_id = case_data.get("id", "")
    stages = case_data.get("stages", [])
    
    enriched_stages = []
    for stage in stages:
        stage_id = stage.get("id", "")
        if stage_id:
            md_content = load_stage_markdown(data_dir, case_id, stage_id)
            if md_content:
                stage = {**stage, "content_md": md_content}
        enriched_stages.append(stage)
    
    return {**case_data, "stages": enriched_stages}


def enrich_stage1_documents_from_markdown(data_dir: Path, case_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Подставить контент документов этапа 1 из .md файлов.
    Связь с конфигом: documents[].id и requestable_documents[].id в case.json → файл {doc_id}.md в stage-1/.
    requestable_documents обогащаются так же, как documents; в интерфейсе они появляются только после
    приложения в чате (session.stage1_requested_documents).
    Не меняет enrich_case_with_markdown; вызывается отдельно из load_case_data и из case_service.get_case.
    Добавлено для этапа 1 (файл в зоне ответственности Леши, см. CONTRIBUTING).
    """
    case_id = case_data.get("id", "")
    stages = case_data.get("stages", [])
    enriched_stages = []
    for stage in stages:
        if stage.get("id") != "stage-1":
            enriched_stages.append(stage)
            continue
        docs = stage.get("documents", [])
        enriched_docs = []
        for doc in docs:
            doc_id = doc.get("id")
            if doc_id:
                content = load_document_markdown(data_dir, case_id, doc_id)
                enriched_docs.append({**doc, "content": content} if content is not None else doc)
            else:
                enriched_docs.append(doc)

        requestable = stage.get("requestable_documents", [])
        enriched_requestable = []
        for rd in requestable:
            doc_id = rd.get("id")
            if doc_id:
                content = load_document_markdown(data_dir, case_id, doc_id)
                enriched_requestable.append({**rd, "content": content} if content is not None else rd)
            else:
                enriched_requestable.append(rd)

        enriched_stages.append({
            **stage,
            "documents": enriched_docs,
            "requestable_documents": enriched_requestable,
        })
    return {**case_data, "stages": enriched_stages}


def _case_dir(data_dir: Path, case_id: str) -> Path:
    """Директория кейса: data/cases/case-XXX (для этапа 4: case-stage-4)."""
    clean = str(case_id).replace("case-", "").strip()
    return data_dir / "cases" / f"case-{clean}"


def resolve_timeline_events_json_path(data_dir: Path, case_id: str) -> Optional[Path]:
    """
    Путь к JSON пулу таймлайна этапа 4.
    Источник истины: stage-4/timeline_events.json; если нет — legacy в корне кейса.
    """
    base = _case_dir(data_dir, case_id)
    preferred = base / "stage-4" / "timeline_events.json"
    if preferred.is_file():
        return preferred
    legacy = base / "timeline_events.json"
    if legacy.is_file():
        return legacy
    return None


def enrich_stage_time_limits_from_game_config(data_dir: Path, case_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Подставить time_budget этапа из {stage_id}/game_config.json (поле time_limit), если в JSON этапа
    лимит не задан явно.

    Клиент (GameplayHud) показывает таймер по stage.time_budget; на этапе 2 лимит LEXIC часто
    задаётся только в game_config, без дублирования в case*.json.
    """
    case_id = case_data.get("id") or ""
    base = _case_dir(data_dir, case_id)
    if not base.is_dir():
        return case_data

    enriched_stages = []
    for stage in case_data.get("stages") or []:
        if not isinstance(stage, dict):
            enriched_stages.append(stage)
            continue
        st = dict(stage)
        tb = st.get("time_budget")
        if tb is not None:
            try:
                ntb = float(tb)
                if ntb > 0:
                    enriched_stages.append(st)
                    continue
                if ntb == 0:
                    enriched_stages.append(st)
                    continue
            except (TypeError, ValueError):
                pass

        stage_id = st.get("id")
        if not stage_id or not isinstance(stage_id, str):
            enriched_stages.append(st)
            continue
        cfg_path = base / stage_id / "game_config.json"
        if not cfg_path.is_file():
            enriched_stages.append(st)
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                gcfg = json.load(f)
        except Exception as e:
            logger.debug(f"⚠️ Не удалось прочитать {cfg_path}: {e}")
            enriched_stages.append(st)
            continue
        tlim = (gcfg or {}).get("time_limit") or {}
        if not tlim.get("enabled"):
            enriched_stages.append(st)
            continue
        try:
            sec = int(tlim.get("seconds", 0) or 0)
        except (TypeError, ValueError):
            sec = 0
        if sec > 0:
            st["time_budget"] = sec
        enriched_stages.append(st)

    return {**case_data, "stages": enriched_stages}


def load_crisis_scenarios(data_dir: Path, case_id: str) -> Optional[Dict[str, Any]]:
    """Загрузить сценарии кризисов для этапа 4 (stage-4/crisis_scenarios/crisis_scenarios.json)."""
    path = _case_dir(data_dir, case_id) / "stage-4" / "crisis_scenarios" / "crisis_scenarios.json"
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.debug(f"⚠️ Ошибка загрузки crisis_scenarios {path}: {e}")
        return None


def load_doc_letter_text(data_dir: Path, case_id: str) -> Optional[str]:
    """Загрузить текст письма Дока (stage-4/doc_letter.md) для этапа 4."""
    path = _case_dir(data_dir, case_id) / "stage-4" / "doc_letter.md"
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        start_marker = "## Текст письма"
        if start_marker in content:
            start = content.index(start_marker) + len(start_marker)
            rest = content[start:].strip()
            for end_marker in ["\n---", "\n**Варианты", "\n**От кого"]:
                if end_marker in rest:
                    rest = rest.split(end_marker)[0]
            return rest.strip()
        return content.strip()
    except Exception as e:
        logger.debug(f"⚠️ Ошибка загрузки doc_letter {path}: {e}")
        return None


def load_contract_clauses(data_dir: Path, case_id: str) -> Optional[Dict[str, Any]]:
    """Загрузить пункты договора с вариантами A/B/C для этапа 4 (stage-4/contract/contract.json)."""
    path = _case_dir(data_dir, case_id) / "stage-4" / "contract" / "contract.json"
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.debug(f"⚠️ Ошибка загрузки contract {path}: {e}")
        return None


def load_stage4_full_contract_markdown(data_dir: Path, case_id: str) -> Optional[str]:
    """
    Полный текст договора для модалки «Документы» (как печатная форма): stage-4/contract/contract.md.
    Плейсхолдеры подстановки выбранных пунктов делаются на фронте по номерам из title / clause_id.
    """
    path = _case_dir(data_dir, case_id) / "stage-4" / "contract" / "contract.md"
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:
        logger.debug(f"⚠️ Ошибка загрузки contract.md {path}: {e}")
        return None


def load_timeline_events_pool(data_dir: Path, case_id: str) -> List[Dict[str, Any]]:
    """Загрузить пул событий для таймлайна этапа 4 (stage-4/timeline_events.json или legacy в корне кейса)."""
    path = resolve_timeline_events_json_path(data_dir, case_id)
    if path is not None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("events", data) if isinstance(data, dict) else data
        except Exception as e:
            logger.debug(f"⚠️ Ошибка загрузки timeline_events {path}: {e}")
    return [
        {"month": "Через 1 месяц", "label": "Поставка базовой версии ПО", "status": "done"},
        {"month": "Через 2 месяца", "label": "Согласование доработок по email", "status": "done"},
        {"month": "Через 3 месяца", "label": "Начало кастомной разработки", "status": "done"},
        {"month": "Через 4 месяца", "label": "Задержки внедрения", "status": "warn"},
        {"month": "Через 5 месяцев", "label": "Рост зависимости от вендора", "status": "warn"},
        {"month": "Через 1 месяц", "label": "Подписание задания", "status": "done"},
        {"month": "Через 2 месяца", "label": "Первые результаты", "status": "done"},
        {"month": "Через 3 месяца", "label": "Замечания заказчика", "status": "warn"},
        {"month": "Через 4 месяца", "label": "Доработка по замечаниям", "status": "done"},
        {"month": "Через 5 месяцев", "label": "Срыв сроков сдачи", "status": "warn"},
        {"month": "Через 6 месяцев", "label": "Эскалация по качеству", "status": "warn"},
    ]


def load_reference_docs(data_dir: Path, case_id: str) -> Dict[str, Any]:
    """
    Справочные документы кейса для модального окна «Документы» на всех этапах.

    Папка: data/cases/case-XXX/reference_docs/

    Файлы (все опциональны, кроме того что нужно автору кейса):
      - brief.md           — мок брифа (markdown); для полного цикла с этапом 1 на фронте
                             часто заменяется динамическим брифом из сессии
      - guide_po.md        — гайд по работе с договорами (markdown)
      - risk_matrix.json   — эталонная матрица рисков (JSON с массивом risks), должна
                             совпадать по смыслу с stage-2/risk_matrix.json при одном договоре
    """
    case_dir = _case_dir(data_dir, case_id)
    docs_dir = case_dir / "reference_docs"

    docs: List[Dict[str, Any]] = []

    # Бриф (моковые данные)
    brief_path = docs_dir / "brief.md"
    if brief_path.exists():
        try:
            brief_text = brief_path.read_text(encoding="utf-8")
            docs.append(
                {
                    "id": "brief",
                    "title": "Бриф по сделке",
                    "kind": "markdown",
                    "filename": str(brief_path.name),
                    "content": brief_text,
                }
            )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"⚠️ Ошибка загрузки brief.md для {case_id}: {e}")

    # Гайд по работе с договорами
    guide_path = docs_dir / "guide_po.md"
    if guide_path.exists():
        try:
            guide_text = guide_path.read_text(encoding="utf-8")
            docs.append(
                {
                    "id": "guide_po",
                    "title": "Гайд по работе с договорами",
                    "kind": "markdown",
                    "filename": str(guide_path.name),
                    "content": guide_text,
                }
            )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"⚠️ Ошибка загрузки guide_po.md для {case_id}: {e}")

    # Матрица рисков (визуализация как на этапе 2)
    risk_path = docs_dir / "risk_matrix.json"
    if risk_path.exists():
        try:
            with risk_path.open("r", encoding="utf-8") as f:
                risk_data = json.load(f)
            docs.append(
                {
                    "id": "risk_matrix",
                    "title": "Матрица рисков",
                    "kind": "risk_matrix",
                    "filename": str(risk_path.name),
                    "data": risk_data,
                }
            )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"⚠️ Ошибка загрузки risk_matrix.json для {case_id}: {e}")

    return {
        "case_id": case_id,
        "docs": docs,
    }
