"""Сервис для работы с кейсами.

Раньше кейсы хранились только в файловой системе (data/case*.json).
Сейчас они переносятся в PostgreSQL (таблица "case"), но формат,
который возвращается наружу, остаётся прежним:
- get_all_cases -> список словарей c id/title/description/...;
- get_case      -> полный dict кейса с полем "stages".

Файловая система используется как источник правды только для
первичного наполнения БД (lazy-seed при первом обращении).
"""

from typing import List, Dict, Any, Optional
import logging
from pathlib import Path
import copy
import json
import re

from config import get_case_from_filesystem_env, case_content_redis_ttl_seconds
from db import get_connection
                                                                                                                                  
from utils.file_loader import (
    load_case_data,
    load_all_cases as fs_load_all_cases,
    enrich_case_with_markdown,
    enrich_stage1_documents_from_markdown,
    enrich_stage_time_limits_from_game_config,
)
from seed_contracts import seed_contract_for_case
from services.case_id import canonical_case_code

_case_log = logging.getLogger(__name__)


def materialize_case_content_from_filesystem(data_dir: Path, case_id: Optional[str]) -> Dict[str, Any]:
    """Полный обогащённый кейс с диска (JSON + md + лимиты)."""
    code = canonical_case_code(case_id)
    case_data = load_case_data(data_dir, code)
    case_data = enrich_case_with_markdown(data_dir, case_data)
    case_data = enrich_stage1_documents_from_markdown(data_dir, case_data)
    case_data = enrich_stage_time_limits_from_game_config(data_dir, case_data)
    return case_data


def get_case_stage_count_from_db(case_code: str) -> Optional[int]:
    """
    Число этапов из БД без загрузки полного case_content_json (для быстрых проверок).
    Возвращает None, если строки кейса нет.
    """
    code = canonical_case_code(case_code)
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(
                    jsonb_array_length(case_content_json->'stages'),
                    jsonb_array_length(settings_json->'stages'),
                    0
                )
                FROM "case"
                WHERE code = %s
                LIMIT 1
                """,
                (code,),
            )
            row = cur.fetchone()
    if not row:
        return None
    try:
        return int(row[0] or 0)
    except (TypeError, ValueError):
        return 0


def _load_case_content_json_from_db(code: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT case_content_json FROM "case" WHERE code = %s LIMIT 1',
                (code,),
            )
            row = cur.fetchone()
    if not row or row[0] is None:
        return None
    j = row[0]
    if isinstance(j, dict):
        return copy.deepcopy(j)
    if isinstance(j, str):
        return json.loads(j)
    return copy.deepcopy(dict(j))


def _case_content_synced_at_iso(code: str) -> Optional[str]:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT case_content_synced_at FROM "case" WHERE code = %s LIMIT 1',
                (code,),
            )
            row = cur.fetchone()
    if not row or row[0] is None:
        return None
    ts = row[0]
    if hasattr(ts, "isoformat"):
        return ts.isoformat()
    return str(ts)


def case_http_etag(case_id: Optional[str]) -> str:
    """ETag для GET /api/case (по времени материализации case_content_json)."""
    code = canonical_case_code(case_id)
    synced = _case_content_synced_at_iso(code) or "na"
    return f'"{code}:{synced}"'


def refresh_case_content_json_for_code(data_dir: Path, case_id: Optional[str]) -> Dict[str, Any]:
    """
    Перечитать кейс с диска, обновить settings_json (сырой) и case_content_json (обогащённый).
    """
    from services.redis_client import redis_delete_case_cache

    code = canonical_case_code(case_id)
    enriched = materialize_case_content_from_filesystem(data_dir, code)
    raw = load_case_data(data_dir, code)
    _upsert_case_row(raw)
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "case"
                SET case_content_json = %s::jsonb,
                    case_content_synced_at = NOW()
                WHERE code = %s
                """,
                (json.dumps(enriched, ensure_ascii=False), code),
            )
    redis_delete_case_cache(code)
    return enriched


def _upsert_case_row(case_data: Dict[str, Any]) -> None:
    """Создать или обновить запись кейса в БД по данным из JSON."""
    code = case_data.get("id")
    if not code:
        return

    title = case_data.get("title") or ""
    description = case_data.get("description") or ""
    status = case_data.get("status") or "published"
    lexic_initial = case_data.get("lexic_initial")

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "case" (code, title, description, status, lexic_initial, settings_json)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb)
                ON CONFLICT (code) DO UPDATE SET
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    status = EXCLUDED.status,
                    lexic_initial = EXCLUDED.lexic_initial,
                    settings_json = EXCLUDED.settings_json,
                    updated_at = NOW()
                """,
                (
                    code,
                    title,
                    description,
                    status,
                    json.dumps(lexic_initial) if lexic_initial is not None else None,
                    json.dumps(case_data),
                ),
            )


def _ensure_db_seeded(data_dir: Path) -> None:
    """
    Исторический lazy-seed: если таблица case пустая — заполнить её из data/case*.json.

    Для актуализации кейсов и связанных ресурсов на старте проекта
    рекомендуется вызывать seed_cases_and_resources_on_startup (см. ниже).
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT COUNT(*) FROM "case"')
            count = cur.fetchone()[0]

    if count > 0:
        return

                                    
    fs_cases = fs_load_all_cases(data_dir)
    for case in fs_cases:
        _upsert_case_row(case)
        code = case.get("id")
        if code:
            try:
                seed_contract_for_case(code)
            except Exception as e:
                print(f"⚠️ Не удалось засеять договор для кейса {code}: {e}")
            try:
                refresh_case_content_json_for_code(data_dir, str(code))
            except Exception as e:
                _case_log.exception("_ensure_db_seeded: case_content_json для %s", code)
                print(f"⚠️ case_content_json для {code}: {e}")


def seed_cases_and_resources_on_startup(data_dir: Path) -> None:
    """
    Обновить в БД все кейсы и связанные с ними ресурсы (договоры) на старте проекта.

    - читает все case*.json через fs_load_all_cases;
    - upsert-ит записи в таблице "case";
    - для каждого кейса вызывает seed_contract_for_case(case_id),
      который подтягивает contract из файлов ресурсов.
    """
    fs_cases = fs_load_all_cases(data_dir, published_only=False)
    for case in fs_cases:
        _upsert_case_row(case)
        code = case.get("id")
        if code:
            try:
                seed_contract_for_case(code)
            except Exception as e:
                print(f"⚠️ Не удалось засеять договор для кейса {code}: {e}")
            try:
                refresh_case_content_json_for_code(data_dir, str(code))
            except Exception as e:
                _case_log.exception("seed: case_content_json для %s", code)
                print(f"⚠️ case_content_json для {code}: {e}")


def force_reseed_cases_from_fs(data_dir: Path, *, fail_on_contract_seed_errors: bool = False) -> None:
    """
    Принудительная синхронизация БД с кейсами из папок проекта.

    - Загружает все case*.json из data_dir (все статусы, включая draft);
    - Удаляет из таблицы "case" записи, которых нет в файлах;
    - Upsert-ит актуальные кейсы и подтягивает договоры (seed_contract_for_case).

    Вызывается при старте приложения, чтобы список кейсов в БД совпадал с файлами.

    При fail_on_contract_seed_errors=True (кнопка «Синхронизировать» в админке) любая ошибка
    сидирования договора приводит к исключению — чтобы прод не молчал при сбое.
    """
    fs_cases = fs_load_all_cases(data_dir, published_only=False)
    codes = [c.get("id") for c in fs_cases if c.get("id")]
    contract_errors: List[str] = []

    with get_connection() as conn:
        with conn.cursor() as cur:
                                                                                          
            cur.execute('DELETE FROM "case" WHERE code = %s', ("case-004",))
            if cur.rowcount:
                print("🗑️ Удалён устаревший кейс case-004 (контент в case-stage-4).")
            if codes:
                placeholders = ",".join(["%s"] * len(codes))
                cur.execute(
                    f'DELETE FROM "case" WHERE code NOT IN ({placeholders})',
                    tuple(codes),
                )
                deleted = cur.rowcount
                if deleted:
                    print(f"🗑️ Удалено из БД кейсов, отсутствующих в файлах: {deleted}")
            else:
                cur.execute('DELETE FROM "case"')
                print("🗑️ Таблица case очищена (нет опубликованных case*.json).")

    synced_codes: List[str] = []
    for case in fs_cases:
        _upsert_case_row(case)
        code = case.get("id")
        if code:
            try:
                seed_contract_for_case(code)
            except Exception as e:
                msg = f"{code}: {e}"
                _case_log.exception("Не удалось засеять договор для кейса %s", code)
                contract_errors.append(msg)
                print(f"⚠️ Не удалось засеять договор для кейса {code}: {e}")
            try:
                refresh_case_content_json_for_code(data_dir, str(code))
                synced_codes.append(str(code))
            except Exception as e:
                _case_log.exception("Не удалось материализовать case_content_json для %s", code)
                print(f"⚠️ case_content_json для {code}: {e}")

                                                                                                      
                                                                                                 
                                                                
    for canonical_id in ("case-001", "case-stage-3"):
        try:
            seed_contract_for_case(canonical_id)
        except Exception as e:
            msg = f"{canonical_id} (канонический договор): {e}"
            _case_log.exception("Каноническое сидирование договора: %s", canonical_id)
            contract_errors.append(msg)
            print(f"⚠️ {msg}")
        try:
            refresh_case_content_json_for_code(data_dir, canonical_id)
            if canonical_id not in synced_codes:
                synced_codes.append(canonical_id)
        except Exception as e:
            _case_log.exception("case_content_json после канонического seed: %s", canonical_id)
            print(f"⚠️ case_content_json для {canonical_id}: {e}")

    print(f"✅ Кейсы синхронизированы с файлами: {len(fs_cases)} кейсов.")
    try:
        from services.redis_client import redis_delete_many_case_caches

        redis_delete_many_case_caches(synced_codes)
    except Exception:
        pass
    if contract_errors:
        joined = "; ".join(contract_errors)
        if fail_on_contract_seed_errors:
            raise RuntimeError(f"Сидирование договоров завершилось с ошибками: {joined}")
        _case_log.error("Сидирование договоров с ошибками (сервер продолжает работу): %s", joined)


def get_all_cases(data_dir: Path, include_all_statuses: bool = False) -> List[Dict[str, Any]]:
    """Получить список кейсов из БД. По умолчанию только published; при include_all_statuses=True — все."""
    _ensure_db_seeded(data_dir)

    cases: List[Dict[str, Any]] = []
    with get_connection() as conn:
        with conn.cursor() as cur:
            if include_all_statuses:
                cur.execute(
                    """
                    SELECT code, title, description, status, lexic_initial, settings_json
                    FROM "case"
                    ORDER BY id
                    """
                )
            else:
                cur.execute(
                    """
                    SELECT code, title, description, status, lexic_initial, settings_json
                    FROM "case"
                    WHERE status = 'published'
                    ORDER BY id
                    """
                )
            rows = cur.fetchall()

    for code, title, description, status, lexic_initial, settings_json in rows:
        settings = settings_json or {}
        tags_raw = settings.get("tags")
        if isinstance(tags_raw, list) and tags_raw and all(isinstance(x, str) for x in tags_raw):
            tags = list(tags_raw)
        else:
            tags = _determine_tags(title or "")                                     

                                                                                      
        li = lexic_initial or settings.get("lexic_initial") or {
            "L": 50,
            "E": 50,
            "X": 50,
            "I": 50,
            "C": 50,
        }

        version = settings.get("version", 1)
        stages = settings.get("stages", [])

        config_file = "data/case.json" if code == "case-001" else f"data/{code}.json"
        data_folder = f"data/cases/{code}"
        resources = _collect_case_resources(settings)

                                                                               
        stages_preview = [
            {"id": s.get("id"), "title": s.get("title") or "", "order": s.get("order", i)}
            for i, s in enumerate(stages)
        ]
        cases.append(
            {
                "id": code,
                "title": title,
                "description": description,
                "status": status,
                "tags": tags,
                "lexic_initial": li,
                "version": version,
                "stages_count": len(stages),
                "stages": stages_preview,
                "config_file": config_file,
                "data_folder": data_folder,
                "resources": resources,
                "cover_image": settings.get("cover_image"),
            }
        )

                                                                                                            
    def _case_order_key(c: Dict[str, Any]) -> tuple:
        code = c.get("id", "")
        if code == "case-001":
            return (0, 0)
        if code == "case-stage-1":
            return (1, 1)
        if code == "case-stage-2":
            return (1, 2)
        if code == "case-stage-3":
            return (1, 3)
        if code == "case-stage-4":
            return (1, 4)
        return (2, code)

    cases.sort(key=_case_order_key)
    return cases


def _collect_case_resources(case_data: Dict[str, Any]) -> List[str]:
    """Собрать список путей к ресурсам кейса из contract и stages[].resources."""
    paths: List[str] = []
    seen: set = set()

    def add(p: Optional[str]) -> None:
        if p and isinstance(p, str) and p.strip() and p not in seen:
            seen.add(p)
            paths.append(p.strip())

    contract = case_data.get("contract") or {}
    add(contract.get("md_path"))
    add(contract.get("gamedata_path"))

    for stage in case_data.get("stages", []):
        res = stage.get("resources") or {}
        for v in res.values():
            add(v)

    return paths


_RE_DATA_CASES_FILE = re.compile(r"^data/cases/(case-[a-zA-Z0-9_-]+)/(.+)$")
_RE_COVER_REF = re.compile(r"^cases/(case-[a-zA-Z0-9_-]+)/cover$")


def _dependency_resolve_file_target(data_dir: Path, raw_path: str) -> Dict[str, Any]:
    """
    Сопоставить строку пути из JSON с целью для GET/PUT /api/admin/cases/:id/file.

    Возвращает словарь: file_target_case_id, file_rel_path (или None, если не файл в data/cases),
    exists, absolute_repo_path (строка от корня data/ для отладки).
    """
    p = (raw_path or "").strip()
    out: Dict[str, Any] = {
        "file_target_case_id": None,
        "file_rel_path": None,
        "exists": False,
        "absolute_repo_path": None,
    }
    if not p:
        return out

    m = _RE_DATA_CASES_FILE.match(p.replace("\\", "/"))
    if m:
        owner = m.group(1)
        rel = m.group(2).lstrip("/")
        abs_path = (data_dir / "cases" / owner / rel).resolve()
        out["file_target_case_id"] = owner
        out["file_rel_path"] = rel
        out["exists"] = abs_path.is_file()
        try:
            out["absolute_repo_path"] = str(abs_path.relative_to(data_dir.parent))
        except ValueError:
            out["absolute_repo_path"] = str(abs_path)
        return out

    c = _RE_COVER_REF.match(p.replace("\\", "/"))
    if c:
        owner = c.group(1)
        rel = "cover.png"
        abs_path = (data_dir / "cases" / owner / rel).resolve()
        out["file_target_case_id"] = owner
        out["file_rel_path"] = rel
        out["exists"] = abs_path.is_file()
        try:
            out["absolute_repo_path"] = str(abs_path.relative_to(data_dir.parent))
        except ValueError:
            out["absolute_repo_path"] = str(abs_path)
        return out

    return out


def build_case_dependency_report(data_dir: Path, case_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Сводка файловых зависимостей кейса для редактора (без правки JSON вручную).

    Учитывает: cover_image, contract.*_path, stages[].resources, документы stage-1 (конвенция .md),
    типовые файлы этапа 4 (если этап есть в конфиге).
    """
    editor = _canonical_case_folder_id(str(case_data.get("id") or "").strip() or "case-unknown")
    items: List[Dict[str, Any]] = []
    pointer_by_norm_path: Dict[str, List[str]] = {}

    def push_item(
        group: str,
        label: str,
        json_pointer: str,
        raw_path: str,
        *,
        implicit: bool = False,
    ) -> None:
        rp = (raw_path or "").strip()
        if not rp:
            return
        resolved = _dependency_resolve_file_target(data_dir, rp)
        foreign = bool(
            resolved.get("file_target_case_id") and resolved["file_target_case_id"] != editor
        )
        row = {
            "group": group,
            "label": label,
            "json_pointer": json_pointer,
            "raw_path": rp,
            "implicit": implicit,
            "file_target_case_id": resolved.get("file_target_case_id"),
            "file_rel_path": resolved.get("file_rel_path"),
            "exists": bool(resolved.get("exists")),
            "foreign_case": foreign,
            "absolute_repo_path": resolved.get("absolute_repo_path"),
        }
        if foreign:
            row["warning"] = (
                f"Файл лежит в папке другого кейса ({resolved.get('file_target_case_id')}), "
                f"не в {editor}. Удобно для одноэтапных шаблонов — проверьте согласованность при копировании."
            )
        elif not resolved.get("file_rel_path"):
            row["warning"] = "Путь не разобран как data/cases/... или cases/.../cover — открыть через API файлов нельзя."
        items.append(row)
        key = rp.replace("\\", "/")
        pointer_by_norm_path.setdefault(key, []).append(json_pointer)

    case_inner_id = str(case_data.get("id") or "").strip()
    clean_json = str(case_inner_id).replace("case-", "").strip()
    if clean_json in ("001", "") or case_inner_id == "case-001":
        cfg_rel = "data/case.json"
    else:
        cfg_rel = f"data/case-{clean_json}.json"

             
    cov = case_data.get("cover_image")
    if isinstance(cov, str) and cov.strip():
        push_item("Обложка и оформление", "Обложка карточки (cover.png)", "cover_image", cov.strip())

    contract = case_data.get("contract") or {}
    if isinstance(contract, dict):
        if contract.get("md_path"):
            push_item("Договор (глобально)", "contract.md_path (этап 3, БД договора)", "contract.md_path", str(contract.get("md_path")))
        if contract.get("gamedata_path"):
            push_item("Договор (глобально)", "contract.gamedata_path", "contract.gamedata_path", str(contract.get("gamedata_path")))

    for si, stage in enumerate(case_data.get("stages") or []):
        if not isinstance(stage, dict):
            continue
        sid = str(stage.get("id") or f"stage[{si}]")
        title = (stage.get("title") or sid).strip()
        group = f"Этап: {title}"
        res = stage.get("resources") or {}
        if isinstance(res, dict):
            for rk, rv in res.items():
                if isinstance(rv, str) and rv.strip():
                    push_item(group, f"resources.{rk}", f"stages[{si}].{sid}.resources.{rk}", rv.strip())

        if sid == "stage-1":
            for dk in ("documents", "requestable_documents"):
                docs = stage.get(dk) or []
                if not isinstance(docs, list):
                    continue
                for di, doc in enumerate(docs):
                    if not isinstance(doc, dict):
                        continue
                    doc_id = doc.get("id")
                    if not doc_id:
                        continue
                    inferred = f"data/cases/{editor}/stage-1/{doc_id}.md"
                    push_item(
                        group,
                        f"{dk}[{doc_id}] → {doc_id}.md",
                        f"stages[{si}].{sid}.{dk}[{di}].id",
                        inferred,
                        implicit=True,
                    )

    stage_ids = {str(s.get("id")) for s in (case_data.get("stages") or []) if isinstance(s, dict)}
    if "stage-4" in stage_ids:
        implicit_stage4 = [
            ("stage-4/crisis_scenarios/crisis_scenarios.json", "Сценарии кризисов"),
            ("stage-4/contract/contract.json", "Договор для этапа 4"),
            ("stage-4/doc_letter.md", "Письмо Дока"),
        ]
        for rel, human in implicit_stage4:
            abs_p = (data_dir / "cases" / editor / rel).resolve()
            exists = abs_p.is_file()
            try:
                arp = str(abs_p.relative_to(data_dir.parent))
            except ValueError:
                arp = str(abs_p)
            items.append(
                {
                    "group": "Этап 4 (конвенция загрузчика)",
                    "label": human,
                    "json_pointer": f"(implicit) {rel}",
                    "raw_path": f"data/cases/{editor}/{rel}",
                    "implicit": True,
                    "file_target_case_id": editor,
                    "file_rel_path": rel,
                    "exists": exists,
                    "foreign_case": False,
                    "absolute_repo_path": arp,
                    "warning": None
                    if exists
                    else "Ожидаемый путь по коду бэкенда; если файла нет — этап 4 может работать неполно.",
                }
            )

                                                 
    aliases: List[Dict[str, Any]] = []
    for norm, ptrs in pointer_by_norm_path.items():
        uniq = sorted(set(ptrs))
        if len(uniq) > 1:
            aliases.append({"raw_path": norm, "json_pointers": uniq})

    missing = sum(1 for it in items if it.get("file_rel_path") and not it.get("exists"))
    foreign_ct = sum(1 for it in items if it.get("foreign_case"))

    return {
        "editor_case_id": editor,
        "config_path": cfg_rel,
        "items": items,
        "same_path_aliases": aliases,
        "stats": {
            "total": len(items),
            "missing_files": missing,
            "foreign_references": foreign_ct,
        },
    }


def get_case_titles_by_codes(data_dir: Path, codes: List[str]) -> Dict[str, str]:
    """
    Только названия кейсов по кодам — один запрос к БД, без чтения JSON/markdown.
    Для списков сессий («мои отчёты» и т.п.); не тянуть полный get_case на каждую строку.
    """
    uniq = sorted({str(c).strip() for c in codes if c and str(c).strip()})
    if not uniq:
        return {}
    _ensure_db_seeded(data_dir)
    out: Dict[str, str] = {}
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT code, COALESCE(title, '') AS title
                FROM "case"
                WHERE code = ANY(%s::text[])
                """,
                (uniq,),
            )
            for code, title in cur.fetchall():
                out[str(code)] = (title or "").strip()
    return out


def get_case(
    data_dir: Path,
    case_id: Optional[str] = None,
    *,
    source: str = "db",
) -> Dict[str, Any]:
    """
    Получить конкретный кейс.

    По умолчанию (source=\"db\"): материализованный JSON из PostgreSQL (`case_content_json`),
    заполняемый при синхронизации кейсов / старте. Опционально Redis-кэш.

    source=\"filesystem\": чтение с диска + enrich (админка, правка JSON/md без sync).

    GET_CASE_FROM_FILESYSTEM=1 — принудительно вести себя как filesystem для всех вызовов.
    """
    _ensure_db_seeded(data_dir)

    code = canonical_case_code(case_id)
    use_fs = source == "filesystem" or get_case_from_filesystem_env()

    if use_fs:
        case_data = load_case_data(data_dir, code)
        _upsert_case_row(case_data)
        case_data = enrich_case_with_markdown(data_dir, case_data)
        case_data = enrich_stage1_documents_from_markdown(data_dir, case_data)
        case_data = enrich_stage_time_limits_from_game_config(data_dir, case_data)
        return case_data

    try:
        from services.redis_client import get_redis, redis_case_content_key

        rcli = get_redis()
        ttl = case_content_redis_ttl_seconds()
        if rcli and ttl > 0:
            try:
                cached = rcli.get(redis_case_content_key(code))
                if cached:
                    return json.loads(cached)
            except Exception as e:
                _case_log.debug("redis get case %s: %s", code, e)
    except Exception:
        pass

    from_db = _load_case_content_json_from_db(code)
    if from_db is not None:
        try:
            from services.redis_client import get_redis, redis_case_content_key

            rcli = get_redis()
            ttl = case_content_redis_ttl_seconds()
            if rcli and ttl > 0:
                try:
                    rcli.setex(
                        redis_case_content_key(code),
                        ttl,
                        json.dumps(from_db, ensure_ascii=False),
                    )
                except Exception as e:
                    _case_log.debug("redis set case %s: %s", code, e)
        except Exception:
            pass
        return copy.deepcopy(from_db)

    return refresh_case_content_json_for_code(data_dir, code)


def _determine_tags(title: str) -> List[str]:
    """Определить теги на основе названия кейса (fallback, если в JSON нет поля tags)."""
    title_lower = (title or "").lower()
    if "по" in title_lower or "программ" in title_lower:
        return ["IT", "лицензирование", "ПО"]
    elif "данн" in title_lower:
        return ["перс данные", "GDPR", "лицензирование"]
    elif "аутсорс" in title_lower or "разработк" in title_lower:
        return ["подряд", "IT", "ИС"]
    else:
        return ["подряд", "IT", "перс данные"]


def _case_file_path(data_dir: Path, case_id: str) -> Path:
    """Путь к JSON-файлу кейса. case-001 -> data/case.json, остальные -> data/case-{id}.json."""
    clean = str(case_id).replace("case-", "").strip()
    if clean in ("001", "") or case_id == "case-001":
        return data_dir / "case.json"
    return data_dir / f"case-{clean}.json"


def save_case_to_fs(data_dir: Path, case_data: Dict[str, Any]) -> None:
    """
    Сохранить кейс в файл и БД.
    Файл: для case-001 — data/case.json, иначе data/case-{id}.json.
    Формат файла: { "case": case_data } для совместимости с текущим case.json.
    """
    case_id = case_data.get("id")
    if not case_id:
        raise ValueError("case_data.id обязателен")

    path = _case_file_path(data_dir, case_id)
    path.parent.mkdir(parents=True, exist_ok=True)

                                  
    if path.exists():
        bak = path.with_suffix(path.suffix + ".bak")
        bak.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")

    payload = {"case": case_data}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    _upsert_case_row(case_data)
    try:
        refresh_case_content_json_for_code(data_dir, case_id)
    except Exception as e:
        _case_log.exception("save_case_to_fs: case_content_json для %s", case_id)
        print(f"⚠️ case_content_json после save_case_to_fs({case_id}): {e}")
    if case_data.get("contract"):
        try:
            seed_contract_for_case(case_id)
        except Exception as e:
            print(f"⚠️ seed_contract_for_case({case_id}): {e}")


def create_case(data_dir: Path, title: str = "Новый кейс", description: str = "", stages: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    Создать новый кейс: сгенерировать id, записать файл и папку, вернуть созданный кейс.
    """
    import time
    existing_codes = set()
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT code FROM "case"')
            for (code,) in cur.fetchall():
                existing_codes.add(code)

    for _ in range(100):
        suffix = str(int(time.time() * 1000))[-8:]
        code = f"case-{suffix}"
        if code not in existing_codes:
            break
    else:
        import uuid
        code = f"case-{uuid.uuid4().hex[:8]}"

    case_data = {
        "id": code,
        "title": title or "Новый кейс",
        "description": description or "",
        "status": "draft",
        "version": 1,
        "lexic_initial": {"L": 50, "E": 50, "X": 50, "I": 50, "C": 50},
        "stages": stages or [],
        "intro": "",
        "outro": "",
    }
    path = _case_file_path(data_dir, code)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"case": case_data}, ensure_ascii=False, indent=2), encoding="utf-8")

    case_dir = data_dir / "cases" / code
    (case_dir / "stages").mkdir(parents=True, exist_ok=True)

    _upsert_case_row(case_data)
    try:
        refresh_case_content_json_for_code(data_dir, code)
    except Exception as e:
        _case_log.exception("create_case: case_content_json для %s", code)
        print(f"⚠️ case_content_json после create_case({code}): {e}")
    return case_data


def _case_data_dir(data_dir: Path, case_id: str) -> Path:
    """Директория данных кейса: data/cases/case-{id}."""
    clean = str(case_id).replace("case-", "").strip()
    return data_dir / "cases" / f"case-{clean}"


_RE_DATA_CASE_PREFIX = re.compile(r"data/cases/case-[^/]+/")
_RE_PUB_CASE_PREFIX = re.compile(r"cases/case-[^/]+/")


def _canonical_case_folder_id(case_id: str) -> str:
    s = str(case_id).strip()
    return s if s.startswith("case-") else f"case-{s}"


def _rewrite_case_path_strings(s: str, canonical: str) -> str:
    """Подставить canonical (case-XXX) во все типовые пути к ресурсам другого кейса."""
    prefix_data = f"data/cases/{canonical}/"
    prefix_pub = f"cases/{canonical}/"
    out = _RE_DATA_CASE_PREFIX.sub(prefix_data, s)
    out = _RE_PUB_CASE_PREFIX.sub(prefix_pub, out)
    if out.startswith("data/cases/case-"):
        out = re.sub(r"^data/cases/case-[^/]+$", f"data/cases/{canonical}", out)
    if out.startswith("cases/case-"):
        out = re.sub(r"^cases/case-[^/]+$", f"cases/{canonical}", out)
    return out


def _rewrite_paths_in_tree(obj: Any, canonical: str) -> None:
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, str):
                obj[k] = _rewrite_case_path_strings(v, canonical)
            elif isinstance(v, (dict, list)):
                _rewrite_paths_in_tree(v, canonical)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            if isinstance(item, str):
                obj[i] = _rewrite_case_path_strings(item, canonical)
            elif isinstance(item, (dict, list)):
                _rewrite_paths_in_tree(item, canonical)


def materialize_case_resources(
    data_dir: Path,
    case_id: str,
    case_data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    После копирования скелета (или для черновика с путями шаблона): переписать пути
    data/cases/... и cases/... на id нового кейса; вынести тексты в файлы под
    data/cases/<id>/ — легенды этапов в {stage_id}/legend.md, контент документов
    этапа 1 в stage-1/{doc_id}.md (поле content из JSON удаляется).
    Возвращает копию case_data с обновлёнными путями и урезанным JSON.
    """
    canonical = _canonical_case_folder_id(case_id)
    out = copy.deepcopy(case_data)
    _rewrite_paths_in_tree(out, canonical)

    stages = out.get("stages") or []
    for stage in stages:
        if not isinstance(stage, dict):
            continue
        sid = stage.get("id")
        if not isinstance(sid, str) or not sid.strip():
            continue

        leg = stage.get("legend")
        if isinstance(leg, str) and leg.strip():
            rel = f"{sid}/legend.md"
            write_case_file(data_dir, canonical, rel, leg)
            res = dict(stage.get("resources") or {})
            res["legend_md"] = f"data/cases/{canonical}/{sid}/legend.md"
            stage["resources"] = res
            stage["legend"] = ""

        if sid == "stage-1":
            for key in ("documents", "requestable_documents"):
                docs = stage.get(key)
                if not isinstance(docs, list):
                    continue
                new_docs = []
                for doc in docs:
                    if not isinstance(doc, dict):
                        new_docs.append(doc)
                        continue
                    d = dict(doc)
                    doc_id = d.get("id")
                    content = d.get("content")
                    if doc_id and isinstance(content, str) and content.strip():
                        write_case_file(data_dir, canonical, f"stage-1/{doc_id}.md", content)
                        del d["content"]
                    new_docs.append(d)
                stage[key] = new_docs

    return out


def write_case_methodology_documentation(data_dir: Path, case_data: Dict[str, Any]) -> str:
    """
    Записать в data/cases/<id>/documentation.md методичку с ключом каждого этапа
    (поле stage_key или запасной вариант из intro).

    Возвращает относительный путь внутри каталога кейса: documentation.md
    """
    case_id = case_data.get("id")
    if not case_id:
        raise ValueError("case_data.id обязателен для documentation.md")
    canonical = _canonical_case_folder_id(case_id)
    title = (case_data.get("title") or canonical).strip()
    desc = (case_data.get("description") or "").strip() or "—"
    lines = [
        f"# Документация по кейсу: {title}",
        "",
        f"- **ID:** `{case_data.get('id')}`",
        f"- **Статус:** {case_data.get('status') or '—'}",
        f"- **Версия:** {case_data.get('version', '—')}",
        "",
        "## Описание",
        "",
        desc,
        "",
        "## Ключи этапов",
        "",
        "Ниже — педагогический «ключ» каждого этапа: зачем этап в симуляции и какой результат ожидается.",
        "",
    ]
    raw_stages = [s for s in (case_data.get("stages") or []) if isinstance(s, dict)]

    def _order_key(s: Dict[str, Any]) -> tuple:
        o = s.get("order")
        try:
            return (0, int(o)) if o is not None else (1, 0)
        except (TypeError, ValueError):
            return (1, 0)

    stages = sorted(raw_stages, key=_order_key)
    for s in stages:
        sid = s.get("id") or "?"
        stype = s.get("type") or "—"
        stitle = (s.get("title") or "—").strip()
        order = s.get("order")
        ord_prefix = ""
        if not isinstance(order, bool) and isinstance(order, (int, float)) and float(order) == int(float(order)):
            ord_prefix = f"{int(float(order))}. "
        elif isinstance(order, str) and order.strip().isdigit():
            ord_prefix = f"{int(order.strip())}. "

        key_text = (s.get("stage_key") or "").strip()
        if not key_text:
            intro = (s.get("intro") or "").strip()
            if intro:
                key_text = intro[:600] + ("…" if len(intro) > 600 else "")
            else:
                key_text = (
                    "_(Ключ не задан: нет `stage_key` и пустой `intro` — при следующей генерации "
                    "модель заполнит `stage_key`.)_"
                )

        lines.append(f"### {ord_prefix}{stitle}")
        lines.append("")
        lines.append(f"- **Идентификатор этапа:** `{sid}`")
        lines.append(f"- **Тип:** `{stype}`")
        lines.append("- **Ключ этапа:**")
        lines.append("")
        lines.append(key_text)
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*Файл сформирован автоматически при сохранении кейса (админка, полный черновик).*")
    body = "\n".join(lines)
    write_case_file(data_dir, canonical, "documentation.md", body)
    return "documentation.md"


def copy_case_skeleton(
    data_dir: Path,
    template_case_id: str,
    new_case_id: str,
    *,
    overwrite: bool = False,
) -> None:
    """
    Рекурсивно скопировать data/cases/<template>/ → data/cases/<new>/.
    Если dst уже есть и overwrite=False — не трогаем. Если src нет — no-op.
    """
    import shutil

    src = _case_data_dir(data_dir, template_case_id)
    dst = _case_data_dir(data_dir, new_case_id)
    if not src.exists():
        return
    if dst.exists():
        if not overwrite:
            return
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def read_case_file(data_dir: Path, case_id: str, relative_path: str) -> str:
    """
    Прочитать содержимое файла ресурса кейса.
    relative_path — относительно data/cases/case-{id}/, например stage-2/risk_matrix.json.
    """
    base = _case_data_dir(data_dir, case_id).resolve()
    path = (base / relative_path).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise ValueError("path выходит за пределы директории кейса")
    if not path.exists():
        raise FileNotFoundError(relative_path)
    return path.read_text(encoding="utf-8")


def write_case_file(data_dir: Path, case_id: str, relative_path: str, content: str) -> None:
    """
    Записать содержимое файла ресурса кейса.
    relative_path — относительно data/cases/case-{id}/. Создаёт родительские директории.
    """
    base = _case_data_dir(data_dir, case_id).resolve()
    path = (base / relative_path).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise ValueError("path выходит за пределы директории кейса")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")

