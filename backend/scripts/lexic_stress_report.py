#!/usr/bin/env python3
"""
Собрать Markdown-отчёт по стресс-симуляции границ LEXIC.

  PYTHONPATH=backend:tests python backend/scripts/lexic_stress_report.py
  PYTHONPATH=backend:tests python backend/scripts/lexic_stress_report.py --out path/to/report.md
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO / "backend") not in sys.path:
    sys.path.insert(0, str(REPO / "backend"))
if str(REPO / "tests") not in sys.path:
    sys.path.insert(0, str(REPO / "tests"))

from lexic_stress.simulation import build_report_markdown  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="LEXIC stress bounds Markdown report")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Записать в файл (иначе stdout)",
    )
    args = ap.parse_args()
    md = build_report_markdown()
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(md, encoding="utf-8")
        print(args.out)
    else:
        print(md)


if __name__ == "__main__":
    main()
