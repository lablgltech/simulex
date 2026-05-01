"""Кто может видеть маппинг моста этап 3→4 в отчёте и API (админы + группа «ЛабЛигалТех»)."""

from __future__ import annotations

from typing import Any, Dict, Optional

                                                                          
STAGE4_BRIDGE_EXTRA_GROUP_NAME = "ЛабЛигалТех"


def user_can_view_stage4_bridge(user: Optional[Dict[str, Any]]) -> bool:
    if not user:
        return False
    role = str(user.get("role") or "").strip().lower()
    if role in ("admin", "superuser"):
        return True
    return str(user.get("group_name") or "").strip() == STAGE4_BRIDGE_EXTRA_GROUP_NAME
