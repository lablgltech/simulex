"""
Базовый класс для всех этапов
Каждый этап должен наследоваться от этого класса
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from pathlib import Path


class BaseStage(ABC):
    """
    Базовый класс этапа
    
    Каждый этап должен:
    1. Наследоваться от BaseStage
    2. Реализовать все абстрактные методы
    3. Быть изолированным (не зависеть от других этапов)
    4. Иметь уникальный ID и порядковый номер
    """
    
    def __init__(self, stage_id: str, order: int, case_data: Dict[str, Any]):
        """
        Инициализация этапа
        
        Args:
            stage_id: Уникальный ID этапа (например, "stage-1")
            order: Порядковый номер этапа (1, 2, 3, 4)
            case_data: Данные кейса
        """
        self.stage_id = stage_id
        self.order = order
        self.case_data = case_data
        self.stage_config = self._load_stage_config()
    
    @abstractmethod
    def get_stage_info(self) -> Dict[str, Any]:
        """
        Получить информацию об этапе
        
        Returns:
            Словарь с информацией: title, intro, type, points_budget, etc.
        """
        pass
    
    @abstractmethod
    def get_actions(self) -> List[Dict[str, Any]]:
        """
        Получить список действий этапа
        
        Returns:
            Список действий с полной конфигурацией
        """
        pass
    
    @abstractmethod
    def validate_action(self, action_id: str, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        """
        Валидация действия перед выполнением
        
        Args:
            action_id: ID действия
            session: Данные сессии
        
        Returns:
            (успех, сообщение об ошибке)
        """
        pass
    
    @abstractmethod
    def execute_action(self, action_id: str, session: Dict[str, Any]) -> Dict[str, Any]:
        """
        Выполнить действие этапа
        
        Args:
            action_id: ID действия
            session: Данные сессии
        
        Returns:
            Обновленная сессия
        """
        pass
    
    @abstractmethod
    def can_complete(self, session: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        """
        Проверить, можно ли завершить этап
        
        Args:
            session: Данные сессии
        
        Returns:
            (можно завершить, сообщение об ошибке)
        """
        pass
    
    @abstractmethod
    def on_complete(self, session: Dict[str, Any]) -> Dict[str, Any]:
        """
        Обработка завершения этапа
        
        Args:
            session: Данные сессии
        
        Returns:
            Обновленная сессия
        """
        pass
    
    def _load_stage_config(self) -> Dict[str, Any]:
        """
        Загрузить конфигурацию этапа из case_data
        
        Returns:
            Конфигурация этапа
        """
        stages = self.case_data.get("stages", [])
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            if stage.get("id") == self.stage_id or stage.get("order_index") == self.order:
                return stage
        return {}
    
    def get_stage_data(self) -> Dict[str, Any]:
        """
        Получить полные данные этапа для API
        
        Returns:
            Полные данные этапа
        """
        info = self.get_stage_info()
        actions = self.get_actions()
        return {
            **info,
            "actions": actions,
            "id": self.stage_id,
            "order": self.order,
            "order_index": self.order
        }
