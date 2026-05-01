"""
Фабрика для создания экземпляров этапов
Позволяет динамически создавать этапы по их ID
"""
from typing import Dict, Any, Optional
from stages import get_stage_class, STAGE_REGISTRY
from stages.base_stage import BaseStage


def create_stage(stage_id: str, order: int, case_data: Dict[str, Any]) -> BaseStage:
    """
    Создать экземпляр этапа
    
    Args:
        stage_id: ID этапа (например, "stage-1")
        order: Порядковый номер этапа
        case_data: Данные кейса
    
    Returns:
        Экземпляр этапа
    
    Raises:
        ValueError: Если этап не найден в реестре
    """
    StageClass = get_stage_class(stage_id)
    return StageClass(stage_id, order, case_data)


def get_stage_by_type(stage_type: str, order: int, case_data: Dict[str, Any]) -> Optional[BaseStage]:
    """
    Создать этап по типу (если известен тип, но не ID)
    
    Args:
        stage_type: Тип этапа (например, "context", "negotiation")
        order: Порядковый номер этапа
        case_data: Данные кейса
    
    Returns:
        Экземпляр этапа или None
    """
    # Маппинг типов на ID этапов
    type_to_id = {
        "context": "stage-1",
        "position": "stage-2",
        "negotiation": "stage-3",
        "crisis": "stage-4"
    }
    
    stage_id = type_to_id.get(stage_type)
    if not stage_id:
        return None
    
    try:
        return create_stage(stage_id, order, case_data)
    except ValueError:
        return None
