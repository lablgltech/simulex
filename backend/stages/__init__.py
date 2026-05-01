"""
Модуль этапов
Регистрация всех доступных этапов и связанных с ними сущностей.
"""
from typing import Dict, Type, List, Any
from stages.base_stage import BaseStage

# Дополнительные роутеры, привязанные к конкретным этапам.
# Ключ: ID этапа ("stage-3"), значение: список FastAPI-роутеров.
# Заполняется в файлах самих этапов (например, в stages.stage_3).
STAGE_EXTRA_ROUTERS: Dict[str, List[Any]] = {}

# Импорт всех этапов (после объявления STAGE_EXTRA_ROUTERS, чтобы
# файлы этапов могли его использовать при импорте).
from stages.stage_1 import Stage1  # noqa: E402
from stages.stage_2 import Stage2  # noqa: E402
from stages.stage_3 import Stage3  # noqa: E402
from stages.stage_4 import Stage4  # noqa: E402

# Реестр этапов
STAGE_REGISTRY: Dict[str, Type[BaseStage]] = {
    "stage-1": Stage1,
    "stage-2": Stage2,
    "stage-3": Stage3,
    "stage-4": Stage4,
}


def get_stage_class(stage_id: str) -> Type[BaseStage]:
    """
    Получить класс этапа по ID
    
    Args:
        stage_id: ID этапа
    
    Returns:
        Класс этапа
    
    Raises:
        ValueError: Если этап не найден
    """
    if stage_id not in STAGE_REGISTRY:
        raise ValueError(f"Этап {stage_id} не найден в реестре")
    return STAGE_REGISTRY[stage_id]


def register_stage(stage_id: str, stage_class: Type[BaseStage]):
    """
    Зарегистрировать новый этап
    
    Args:
        stage_id: ID этапа
        stage_class: Класс этапа
    """
    STAGE_REGISTRY[stage_id] = stage_class


def get_all_stage_ids() -> List[str]:
    """Получить список всех зарегистрированных этапов"""
    return list(STAGE_REGISTRY.keys())
