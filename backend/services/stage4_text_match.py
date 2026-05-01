"""Сопоставление согласованного текста этапа 3 с вариантами A/B/C: exact → normalized → fuzzy → LLM → A."""

from __future__ import annotations

import json
import os
import re
from difflib import SequenceMatcher
from typing import Any, Dict, Optional, Tuple

from services.ai_payload import MINIMAL_SYSTEM_MESSAGE


def normalize_for_match(s: str) -> str:
    t = (s or "").strip().lower().replace("ё", "е")
    t = re.sub(r"\s+", " ", t)
    return t


def _ratio(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def hybrid_match_agreed_to_letter(
    agreed_raw: str,
    texts_by_letter: Dict[str, str],
) -> Tuple[str, str, Dict[str, Any]]:
    """
    Возвращает (letter, source, meta).
    source: exact | normalized | fuzzy | llm | default
    """
    meta: Dict[str, Any] = {}
    agreed = (agreed_raw or "").strip()
    letters = ["A", "B", "C"]
    texts = {L: (texts_by_letter.get(L) or "").strip() for L in letters}

    if not agreed:
        return "A", "default", meta

           
    for L in letters:
        if agreed == texts[L]:
            return L, "exact", meta

    na = normalize_for_match(agreed)
    for L in letters:
        if na and na == normalize_for_match(texts[L]):
            return L, "normalized", meta

    ratios = [(L, _ratio(na, normalize_for_match(texts[L]))) for L in letters]
    ratios.sort(key=lambda x: -x[1])
    best_l, best_r = ratios[0]
    second_r = ratios[1][1] if len(ratios) > 1 else 0.0
    margin = float(os.getenv("STAGE4_FUZZY_MARGIN", "0.05"))
    min_r = float(os.getenv("STAGE4_FUZZY_MIN_RATIO", "0.82"))
    meta["fuzzy_scores"] = {L: r for L, r in ratios}
    if best_r >= min_r and (best_r - second_r) >= margin:
        return best_l, "fuzzy", meta

    if os.getenv("STAGE4_SELECTION_LLM_ENABLED", "").strip().lower() in ("1", "true", "yes"):
        llm = _llm_pick_abc(agreed, texts)
        if llm:
            choice, conf = llm
            meta["llm_confidence"] = conf
            thr = float(os.getenv("STAGE4_LLM_CONFIDENCE_MIN", "0.6"))
            if choice in letters and conf >= thr:
                return choice, "llm", meta

    return "A", "default", meta


def _llm_pick_abc(agreed: str, texts: Dict[str, str]) -> Optional[Tuple[str, float]]:
    try:
        from services.ai_model_config import get_model_for_consumer
        from services.ai_chat_service import _call_openai
    except Exception:
        return None

    model = (os.getenv("STAGE4_BRIDGE_LLM_MODEL") or "").strip()
    if not model:
        model = get_model_for_consumer("stage3")

    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {
                "role": "system",
                "content": MINIMAL_SYSTEM_MESSAGE,
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "agreed_text": agreed,
                        "A": texts.get("A", ""),
                        "B": texts.get("B", ""),
                        "C": texts.get("C", ""),
                    },
                    ensure_ascii=False,
                ),
            },
        ],
    }
    try:
        raw = _call_openai(payload)
    except Exception:
        return None
    if not raw:
        return None
    m = re.search(r"\{[^{}]*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    ch = data.get("choice")
    if ch is not None:
        ch = str(ch).strip().upper()
    try:
        conf = float(data.get("confidence", 0))
    except (TypeError, ValueError):
        conf = 0.0
    if ch not in ("A", "B", "C"):
        return None
    return ch, max(0.0, min(1.0, conf))
