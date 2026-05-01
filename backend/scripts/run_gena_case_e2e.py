#!/usr/bin/env python3
"""
Полный прогон генерации кейса: tests/gena → анкета (живой LLM) → граф генерации.
Запуск из корня репозитория или из backend:
  PYTHONPATH=backend python backend/scripts/run_gena_case_e2e.py

До импорта сервисов задаём лимит раундов анкеты (session_store читает env при import).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
GENA = REPO / "tests" / "gena"
OUT = GENA / "out"

sys.path.insert(0, str(BACKEND))

os.environ.setdefault("CASE_GEN_MAX_QUESTIONNAIRE_ROUNDS", "24")

import config  # noqa: E402, F401

from services.case_generation.facade import (  # noqa: E402
    run_case_gen_generation,
    start_case_gen_session,
    submit_case_gen_answers,
)
from services.case_generation.questionnaire_profile import (  # noqa: E402
    build_questionnaire_profile,
    snapshot_questions_pack,
)
from services.case_generation.session_store import require_session  # noqa: E402


def _auto_answers(questions: list) -> dict:
    out: dict = {}
    for q in questions:
        qid = q.get("id")
        if not qid:
            continue
        opts = q.get("options") or []
        selected: list = []
        if opts and isinstance(opts[0], dict) and opts[0].get("value") is not None:
            if q.get("selection_required", True):
                vals = [str(o["value"]) for o in opts if isinstance(o, dict) and o.get("value") is not None]
                if q.get("choice_mode") == "multi" and len(vals) >= 2:
                    selected = vals[:2]
                elif vals:
                    selected = [vals[0]]
        out[qid] = {"selected": selected, "details": ""}
    return out


def _force_finish_questionnaire(user_id: int, session_id: str) -> None:
    """Если модель не ставит questionnaire_complete — собираем профиль из ответов и идём в генерацию."""
    s = require_session(session_id, user_id)
    if s.current_questions:
        s.questions_history.append(snapshot_questions_pack(s))
    s.current_questions = []
    s.questionnaire_complete = True
    s.status = "ready_to_generate"
    s.questionnaire_profile = build_questionnaire_profile(s)


def main() -> int:
    if not (os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip():
        print("Нужен OPENROUTER_API_KEY или OPENAI_API_KEY в backend/.env", file=sys.stderr)
        return 1

    contract = (GENA / "contract_template.md").read_text(encoding="utf-8")
    guide = (GENA / "guide.md").read_text(encoding="utf-8")
    intent = (GENA / "creator_prompt.txt").read_text(encoding="utf-8").strip()

    uid = 999001
    print("=== start_case_gen_session (case-001 + gena) ===", flush=True)
    r = start_case_gen_session(
        user_id=uid,
        template_case_id="case-001",
        creator_intent=intent,
        contract_template=contract,
        guide=guide,
        options={},
    )
    sid = r["session_id"]
    print(f"session_id={sid} round={r.get('round')} qs={len(r.get('questions') or [])}", flush=True)
    if r.get("warnings"):
        print("warnings:", r["warnings"], flush=True)

    client_max = 30
    for _ in range(client_max):
        if r.get("questionnaire_complete"):
            break
        if r.get("stuck"):
            print("=== force_finish после stuck API (лимит раундов / ошибка) ===", flush=True)
            _force_finish_questionnaire(uid, sid)
            break
        qs = r.get("questions") or []
        if not qs:
            print("Нет вопросов и анкета не завершена", r, file=sys.stderr)
            return 3
        ans = _auto_answers(qs)
        print(f"=== submit answers round={r.get('round')} ===", flush=True)
        r = submit_case_gen_answers(user_id=uid, session_id=sid, answers=ans)
        print(f"round={r.get('round')} qs={len(r.get('questions') or [])} complete={r.get('questionnaire_complete')}", flush=True)
        if r.get("warnings"):
            print("warnings:", r["warnings"], flush=True)

    sess = require_session(sid, uid)
    if not sess.questionnaire_complete:
        print("=== force_finish (модель не закрыла анкету) ===", flush=True)
        _force_finish_questionnaire(uid, sid)

    print("=== run_case_gen_generation ===", flush=True)
    gen = run_case_gen_generation(user_id=uid, session_id=sid)
    draft = gen.get("draft") or {}
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "merged_case.json"
    out_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    meta_path = OUT / "e2e_meta.json"
    meta_path.write_text(
        json.dumps(
            {
                "merged_case_path": str(out_path),
                "title": draft.get("title"),
                "stages": len(draft.get("stages") or []),
                "validation_errors": gen.get("validation_errors"),
                "gen_warnings_head": (gen.get("warnings") or [])[:12],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"draft -> {out_path}", flush=True)
    print(f"meta -> {meta_path}", flush=True)
    print(f"title={draft.get('title')!r} stages={len(draft.get('stages') or [])}", flush=True)
    if gen.get("warnings"):
        print("gen_warnings:", gen.get("warnings")[:8], flush=True)
    if not draft.get("stages"):
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
