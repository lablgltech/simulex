"""Зеркало строк для отладки этапа 3: файл + память для просмотра в браузере."""

from __future__ import annotations

from collections import deque
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional

MIRROR_PATH = Path(__file__).resolve().parent / "dev_stage3_chat_mirror.log"
REPO_ROOT = Path(__file__).resolve().parent.parent

# Список путей к файлам промптов/контекста, из которых собран запрос к LLM (переговоры v2).
_ai_context_files: ContextVar[Optional[list[str]]] = ContextVar(
    "ai_context_files", default=None
)

_MEMORY_MAX = 2500
_memory: deque[str] = deque(maxlen=_MEMORY_MAX)
_memory_lock = Lock()


def _push_memory(row: str) -> None:
    with _memory_lock:
        _memory.append(row)


def get_recent_lines(limit: int = 500) -> list[str]:
    """Последние строки из памяти; при малом буфере — хвост файла."""
    lim = max(1, min(limit, 5000))
    with _memory_lock:
        mem = list(_memory)
    if len(mem) >= lim:
        return mem[-lim:]
    tail = _read_file_tail(lim)
    merged = tail + mem
    return merged[-lim:] if len(merged) > lim else merged


def _read_file_tail(max_lines: int) -> list[str]:
    if not MIRROR_PATH.is_file():
        return []
    try:
        raw = MIRROR_PATH.read_text(encoding="utf-8", errors="replace")
        lines = raw.splitlines()
        return lines[-max_lines:] if len(lines) > max_lines else lines
    except OSError:
        return []


def append_mirror(line: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    row = f"{ts} {line}"
    _push_memory(row)
    try:
        with MIRROR_PATH.open("a", encoding="utf-8") as f:
            f.write(row + "\n")
    except OSError:
        pass


def touch_startup_banner(api_port: int) -> None:
    """Создать файл сразу при старте, чтобы путь для Get-Content всегда существовал."""
    try:
        MIRROR_PATH.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat()
        row = (
            f"{ts} === API старт (порт {api_port}) — здесь появятся [API]/[CHAT] после запросов "
            f"из чата этапа 3 (браузер :3000 → прокси /api → :{api_port}) ==="
        )
        _push_memory(row)
        with MIRROR_PATH.open("a", encoding="utf-8") as f:
            f.write(row + "\n")
    except OSError:
        pass


def ai_context_file_capture_start() -> None:
    """Начать сбор путей файлов для одного вызова evaluate_player_message (переговоры v2)."""
    _ai_context_files.set([])


def record_ai_context_source_file(path: Path | str) -> None:
    """Записать путь к файлу, попавшему в контекст ИИ (при активном capture)."""
    bucket = _ai_context_files.get()
    if bucket is None:
        return
    try:
        s = str(Path(path).resolve())
    except OSError:
        return
    if s not in bucket:
        bucket.append(s)


def ai_context_file_capture_flush_mirror(
    *,
    case_code: str = "",
    clause: str = "",
    turn: str = "",
) -> None:
    """Завершить сбор и дописать в mirror.log строку [AI_CONTEXT_FILES] …"""
    bucket = _ai_context_files.get()
    _ai_context_files.set(None)
    if not bucket:
        return
    rels: list[str] = []
    for s in bucket:
        try:
            rels.append(str(Path(s).resolve().relative_to(REPO_ROOT)))
        except ValueError:
            rels.append(s)
    meta_parts = []
    if (case_code or "").strip():
        meta_parts.append(f"case={case_code.strip()}")
    if (clause or "").strip():
        meta_parts.append(f"clause={clause.strip()}")
    if (turn or "").strip():
        meta_parts.append(f"turn={turn.strip()}")
    meta = " ".join(meta_parts)
    if meta:
        append_mirror(f"[AI_CONTEXT_FILES] {meta} | " + " | ".join(rels))
    else:
        append_mirror("[AI_CONTEXT_FILES] " + " | ".join(rels))


def append_mirror_block(heading: str, body: str) -> None:
    """Многострочный блок (журнал переговоров)."""
    ts = datetime.now(timezone.utc).isoformat()
    head_row = f"{ts} {heading}"
    _push_memory(head_row)
    for ln in (body or "").splitlines():
        _push_memory(f"  {ln}")
    try:
        with MIRROR_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{head_row}\n{body}\n")
    except OSError:
        pass
