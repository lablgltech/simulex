#!/usr/bin/env python3
"""Собирает docs/PROJECT_DOCUMENTATION_FULL.md из README, backend/README и всех *.md в docs/."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "PROJECT_DOCUMENTATION_FULL.md"

# Порядок: сначала точка входа, затем docs/index, остальное — по пути
ORDER_FIRST = [
    ROOT / "README.md",
    ROOT / "backend" / "README.md",
    ROOT / "docs" / "index.md",
    ROOT / "docs" / "GETTING_STARTED.md",
]


def demote_headings(text: str, extra: int = 2) -> str:
    out: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})(\s.*)$", line)
        if m:
            n = min(6, len(m.group(1)) + extra)
            out.append("#" * n + m.group(2))
        else:
            out.append(line)
    return "\n".join(out)


def anchor_for_path(rel: Path) -> str:
    """Стабильный id для ссылки в оглавлении (ASCII, как в типичных оглавлениях GitHub)."""
    s = rel.as_posix().lower().replace("/", "-").replace(".md", "")
    s = re.sub(r"[^a-z0-9_-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "section"


def collect_doc_paths() -> list[Path]:
    docs_dir = ROOT / "docs"
    all_docs = sorted(docs_dir.rglob("*.md"))
    seen = set(ORDER_FIRST)
    ordered: list[Path] = [p for p in ORDER_FIRST if p.exists()]
    for p in all_docs:
        if p in seen:
            continue
        if p.name == OUT.name:
            continue
        ordered.append(p)
        seen.add(p)
    return ordered


def main() -> None:
    parts: list[str] = []
    toc_entries: list[tuple[str, str]] = []

    intro = f"""# Симулекс — полная документация (единый файл)

> Автособранный снимок репозитория: корневой `README.md`, `backend/README.md` и все файлы `docs/**/*.md` (кроме этого файла). Контент кейсов в `data/cases/` сюда не входит — это игровые материалы, не справочник репозитория.  
> Дата сборки (UTC): **{datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")}**.  
> Повторная сборка: `python3 scripts/build_full_documentation.py` из корня репозитория.  
> Перекрёстные ссылки в тексте могут вести на отдельные `.md` в дереве — при чтении здесь ориентируйтесь на заголовки разделов ниже.

"""
    parts.append(intro)

    for path in collect_doc_paths():
        rel = path.relative_to(ROOT)
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        body = demote_headings(raw, extra=2)
        # Заголовок раздела для TOC
        display = rel.as_posix()
        section_title = f"`{display}`"
        anchor = anchor_for_path(rel)
        toc_entries.append((anchor, section_title))

        parts.append(
            f'\n\n---\n\n<a id="{anchor}"></a>\n\n## {section_title}\n\n'
        )
        parts.append(body)
        parts.append("\n")

    toc_lines = ["## Оглавление\n", "\n"]
    for anchor, title in toc_entries:
        toc_lines.append(f"- [{title}](#{anchor})\n")

    final = parts[0] + "".join(toc_lines) + "\n" + "".join(parts[1:])
    OUT.write_text(final, encoding="utf-8")
    print(f"Wrote {OUT} ({len(final)} chars, {len(toc_entries)} sections)")


if __name__ == "__main__":
    main()
