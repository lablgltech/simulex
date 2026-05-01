"""
Pydantic схемы для валидации запросов и ответов
"""
from pydantic import BaseModel
from typing import Optional, Dict, Any, List


class SessionStartRequest(BaseModel):
    case_id: Optional[str] = None
    start_stage: Optional[int] = None  # Для теста: начать с этапа N (1-based)


class NegotiationSessionStartRequest(BaseModel):
    """
    Запуск сессии переговоров для этапа 3.
    """
    session: Dict[str, Any]
    contract_code: Optional[str] = "dogovor_PO"
    # True — вернуть текст договора и статусы пунктов к исходным (новый «заход» без локального кэша сессии).
    reset_contract_to_initial: Optional[bool] = False


class ActionExecuteRequest(BaseModel):
    action_id: str
    session: Dict[str, Any]


class StageCompleteRequest(BaseModel):
    stage_id: str
    session: Dict[str, Any]


class StageRestartRequest(BaseModel):
    """Сброс прогресса текущего этапа (current_stage не меняется)."""
    session: Dict[str, Any]


class Stage2ValidateRequest(BaseModel):
    """Валидация рисков этапа 2: сессия, классификация рисков по пунктам, теги типов риска и выбранные «чего не хватает»."""
    session: Dict[str, Any]
    clause_risks: Optional[Dict[str, Any]] = None
    clause_tags: Optional[Dict[str, List[str]]] = None  # clause_id -> ['legal', 'financial', ...]
    missing_conditions: Optional[List[str]] = None  # выбранные пункты из облака «В договоре не хватает условий»
    # Секунды на этапе 2 с момента входа (для E: уложился в лимит из game_config.time_limit)
    stage2_seconds_elapsed: Optional[int] = None


class Stage2JustificationRequest(BaseModel):
    """Обоснование выбора пункта для босса: сессия, clause_id, выбранные причины."""
    session: Dict[str, Any]
    clause_id: str
    selected_reasons: Optional[List[str]] = None  # пункты из модалки «А почему именно этот?»


class ReportGenerateRequest(BaseModel):
    session: Dict[str, Any]


class CaseResponse(BaseModel):
    id: str
    title: str
    description: Optional[str] = None
    status: str = "published"
    tags: List[str] = []
    lexic: Dict[str, int] = {}


class SessionResponse(BaseModel):
    id: str
    case_id: str
    case_version: int
    started_at: str
    current_stage: int
    lexic: Dict[str, int]
    resources: Dict[str, Any]
    actions_done: List[str]
    stage_scores: Dict[str, Any]
    crisis_injected: bool
    stage_transitions: Dict[str, Any]
