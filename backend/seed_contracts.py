"""
Наполнение таблицы contract базовыми договорами на основе JSON-конфигураций кейсов.

Можно запускать отдельно:

    python3 seed_contracts.py

А также вызывать программно (например, при старте этапа 3) через
функцию seed_contract_for_case(case_code).
"""

from __future__ import annotations

import json
import logging
from typing import Dict, Any, Optional

from psycopg2.extras import Json

from db import get_connection
from config import BASE_DIR, DATA_DIR

logger = logging.getLogger(__name__)


def _load_case_json_for_code(case_code: str) -> Optional[Dict[str, Any]]:
    """
    Загрузить JSON-конфиг кейса по его коду.

    - case-001 → data/case.json
    - любой другой (например, case-stage-3) → data/{case_code}.json
    """
    if case_code == "case-001":
        path = DATA_DIR / "case.json"
    else:
        path = DATA_DIR / f"{case_code}.json"

    if not path.exists():
        return None

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def seed_contract_for_case(case_code: str) -> None:
    """
    Убедиться, что в таблице contract есть (и актуальна) запись договора,
    описанного в JSON-конфиге кейса.

    Ожидается структура (пути к ресурсам могут быть любыми, но
    в текущей версии используются data/cases/case-XXX/stage-X/...):

    {
      "case": {
        ...,
        "contract": {
          "code": "lease_office",
          "description": "...",
          "md_path": "data/cases/case-XXX/stage-3/lease_office_contract.md",
          "gamedata_path": "data/cases/case-XXX/stage-3/lease_office_gameData.json"
        }
      }
    }
    """
    data = _load_case_json_for_code(case_code)
    if not data:
        return

    case = data.get("case") or {}
    contract_cfg = case.get("contract")
    if not contract_cfg:
        return

    code = contract_cfg.get("code")
    if not code:
        return

    description = contract_cfg.get("description") or f"Договор для кейса {case_code}"
    md_path_rel = contract_cfg.get("md_path")
    gamedata_path_rel = contract_cfg.get("gamedata_path")
    if not md_path_rel or not gamedata_path_rel:
        return

    md_path = (BASE_DIR / md_path_rel).resolve()
    gamedata_path = (BASE_DIR / gamedata_path_rel).resolve()
    if not gamedata_path.exists():
        raise RuntimeError(f"Не найден файл gameData для договора '{code}': {gamedata_path}")

    with open(gamedata_path, "r", encoding="utf-8") as f:
        game_data = json.load(f)

    with get_connection() as conn:
        with conn.cursor() as cur:
            # Проверяем, есть ли уже такой договор
            cur.execute("SELECT id FROM contract WHERE code = %s", (code,))
            row = cur.fetchone()
            if row:
                # Обновляем существующую запись
                cur.execute(
                    """
                    UPDATE contract
                    SET description = %s,
                        link_md = %s,
                        link_gamedata_json = %s,
                        game_data_json = %s
                    WHERE code = %s
                    """,
                    (
                        description,
                        md_path_rel,
                        gamedata_path_rel,
                        Json(game_data),
                        code,
                    ),
                )
                if cur.rowcount != 1:
                    raise RuntimeError(
                        f"UPDATE contract не обновил ровно одну строку (code={code!r}, rowcount={cur.rowcount}). "
                        "Проверьте таблицу contract."
                    )
            else:
                # Вставляем новую запись
                cur.execute(
                    """
                    INSERT INTO contract (code, description, link_md, link_gamedata_json, game_data_json)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        code,
                        description,
                        md_path_rel,
                        gamedata_path_rel,
                        Json(game_data),
                    ),
                )
                if cur.rowcount != 1:
                    raise RuntimeError(
                        f"INSERT contract ожидалось rowcount=1, получено {cur.rowcount} (code={code!r})."
                    )
    logger.info(
        "Засеян договор из кейса: case=%s contract_code=%s gamedata=%s",
        case_code,
        code,
        gamedata_path_rel,
    )


def seed_all_contracts() -> None:
    """
    Пройти по основному кейсу и отдельным кейсам-этапам
    и засеять/обновить все описанные в них договоры.
    """
    # Основной кейс
    seed_contract_for_case("case-001")
    # Отдельные кейсы-этапы (если присутствуют)
    for name in ["case-stage-1", "case-stage-2", "case-stage-3", "case-stage-4"]:
        seed_contract_for_case(name)


def seed_lease_office() -> None:
    """
    Обратная совместимость для тестов: ранее ожидался договор lease_office.
    Фактический договор полного кейса — dogovor_PO (см. data/case.json).
    """
    seed_contract_for_case("case-001")


if __name__ == "__main__":
    seed_all_contracts()
    print("✅ Договоры из кейсов засеяны/обновлены в таблице contract.")

