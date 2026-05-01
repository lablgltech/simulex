"""Единая нормализация кода кейса (внешний контракт: ровно один префикс case-)."""

from typing import Optional

_DEFAULT = "case-001"


def canonical_case_code(raw: Optional[str]) -> str:
    """
    Привести произвольный ввод к каноническому коду case-XXX.

    - None / пустая строка -> case-001
    - Повторяющиеся префиксы case- слева снимаются (case-case-stage-1 -> case-stage-1)
    - 001 -> case-001
    - Иначе: один префикс case- перед оставшимся суффиксом
    """
    if raw is None:
        return _DEFAULT
    s = str(raw).strip()
    if not s:
        return _DEFAULT
    while s.startswith("case-"):
        s = s[5:].lstrip()
    if not s:
        return _DEFAULT
    if s == "001":
        return _DEFAULT
    return f"case-{s}"


def case_suffix(canonical_code: str) -> str:
    """Суффикс после case- для путей вида data/cases/case-{suffix}/ (canonical уже нормализован)."""
    s = str(canonical_code).strip()
    if s.startswith("case-"):
        return s[5:].strip() or "001"
    return s.strip() or "001"
