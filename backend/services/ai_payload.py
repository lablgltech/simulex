from __future__ import annotations

import json
from typing import Any

MINIMAL_SYSTEM_MESSAGE = "."

def compact_user_payload(payload: dict[str, Any], preamble: str | None = None) -> str:
    return (preamble or ".") + "\n\n" + json.dumps(payload, ensure_ascii=False)
