"""Утилиты для валидации данных"""
from typing import Any

def clamp(val: float, min_val: float, max_val: float) -> float:
    """Ограничить значение в диапазоне"""
    return min(max_val, max(min_val, val))
