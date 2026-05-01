"""
Сервис для загрузки и парсинга правил оценки ответов из промптов кейса.

Промпты содержат:
- `ai_negotiation_system_prompt.md` — системный промпт переговоров (v2 / общие правила)
- `ai_case_PO_scoring_rubric.md` — рубрика по пунктам (эталоны, score) для post_llm и парсеров; **не** в system LLM-контрагента
- `ai_case_PO_counterparty_prompt.md` — краткие ограничения роли контрагента для LLM

Рубрика и общий промпт объединяются в `load_full_prompt` для извлечения правил по пунктам (`get_clause_rules_from_prompt` и т. п.). В вызовы оппонента передаются negotiation + counterparty brief (см. `load_counterparty_case_brief_for_llm`).

Рубрика используется для:
- Эталонные редакции пунктов
- Примеры правильных и неправильных ответов  
- Достаточные обоснования для каждого пункта
- Правила оценки (10-балльная шкала)
- Условия завершения переговоров

Этот сервис извлекает эту информацию и использует её для детерминированной проверки
ответов игрока (до обращения к LLM).
"""

from __future__ import annotations

import re
from pathlib import Path
from functools import lru_cache
from typing import Dict, Any, List, Optional
import logging

from config import DATA_DIR
from services.ai_counterpart_rules import strip_revision_meta_from_clause_draft

logger = logging.getLogger(__name__)


@lru_cache(maxsize=16)
def load_counterpart_prompt(case_code: str) -> str:
    """
    Загружает системный промпт переговоров из ai_negotiation_system_prompt.md.
    (Исторически назывался «counterpart prompt»; файл заменён на v2.)
    """
    candidates = [
        DATA_DIR / "cases" / case_code / "stage-3" / "ai_negotiation_system_prompt.md",
        DATA_DIR / "cases" / f"case-{case_code}" / "stage-3" / "ai_negotiation_system_prompt.md",
        DATA_DIR / "cases" / "case-stage-3" / "stage-3" / "ai_negotiation_system_prompt.md",
        DATA_DIR / "cases" / "case-001" / "stage-3" / "ai_negotiation_system_prompt.md",
    ]
    for path in candidates:
        if path.exists():
            try:
                content = path.read_text(encoding="utf-8")
                logger.debug(f"[Prompt] Loaded counterpart prompt: {path}")
                return content
            except Exception:
                continue
    return ""


def _counterparty_brief_candidate_paths(case_code: str, contract_code: str = "") -> List[Path]:
    case_dirs = [
        DATA_DIR / "cases" / case_code / "stage-3",
        DATA_DIR / "cases" / f"case-{case_code}" / "stage-3",
        DATA_DIR / "cases" / "case-stage-3" / "stage-3",
        DATA_DIR / "cases" / "case-001" / "stage-3",
    ]
    filenames: List[str] = []
    if contract_code:
        filenames.append(f"ai_case_{contract_code}_counterparty_prompt.md")
    filenames.extend(
        [
            "ai_case_PO_counterparty_prompt.md",
            "ai_case_counterparty_prompt.md",
        ]
    )
    return [d / fn for d in case_dirs for fn in filenames]


def resolve_counterparty_case_brief_path(
    case_code: str, contract_code: str = ""
) -> Optional[Path]:
    """Первый существующий файл краткого промпта контрагента (как в load_counterparty_case_brief_for_llm)."""
    for path in _counterparty_brief_candidate_paths(case_code, contract_code):
        if path.is_file():
            return path
    return None


@lru_cache(maxsize=16)
def load_counterparty_case_brief_for_llm(case_code: str, contract_code: str = "") -> str:
    """
    Краткий кейсовый блок для LLM-контрагента. Содержимое файлов в модель не передаётся.
    (Парсинг рубрики и правил — через load_case_prompt / load_full_prompt / get_clause_rules_from_prompt.)
    """
    _ = (case_code, contract_code)
    return ""


@lru_cache(maxsize=16)
def load_case_prompt(case_code: str, contract_code: str = "") -> str:
    """
    Загружает рубрику/правила по кейсу для парсеров и post_llm (ai_case_*_scoring_rubric.md
    или устаревшие ai_case_*_prompt.md).
    Ищет сначала по contract_code, затем ai_case_PO_scoring_rubric.md, затем legacy имена.
    """
    case_dirs = [
        DATA_DIR / "cases" / case_code / "stage-3",
        DATA_DIR / "cases" / f"case-{case_code}" / "stage-3",
        DATA_DIR / "cases" / "case-stage-3" / "stage-3",
        DATA_DIR / "cases" / "case-001" / "stage-3",
    ]
    filenames = []
    if contract_code:
        filenames.append(f"ai_case_{contract_code}_scoring_rubric.md")
        filenames.append(f"ai_case_{contract_code}_prompt.md")
    filenames.extend(
        [
            "ai_case_PO_scoring_rubric.md",
            "ai_case_PO_prompt.md",
            "ai_case_prompt.md",
        ]
    )

    candidates = [d / fn for d in case_dirs for fn in filenames]
    for path in candidates:
        if path.exists():
            try:
                content = path.read_text(encoding="utf-8")
                logger.debug(f"[Prompt] Loaded case prompt: {path}")
                return content
            except Exception:
                continue
    return ""


@lru_cache(maxsize=16)
def load_negotiation_knowledge_base(case_code: str, contract_code: str = "") -> str:
    """
    База знаний Q&A для переговоров (короткие эталонные ответы контрагента).
    Файл: negotiation_qa_knowledge_base.md в каталоге stage-3 кейса.
    """
    _ = contract_code
    case_dirs = [
        DATA_DIR / "cases" / case_code / "stage-3",
        DATA_DIR / "cases" / f"case-{case_code}" / "stage-3",
        DATA_DIR / "cases" / "case-stage-3" / "stage-3",
        DATA_DIR / "cases" / "case-001" / "stage-3",
    ]
    name = "negotiation_qa_knowledge_base.md"
    for d in case_dirs:
        path = d / name
        if path.exists():
            try:
                content = path.read_text(encoding="utf-8")
                logger.debug("[Prompt] Loaded negotiation Q&A knowledge base: %s", path)
                return content
            except Exception:
                continue
    return ""


@lru_cache(maxsize=16)
def load_full_prompt(case_code: str, contract_code: str = "dogovor_PO") -> str:
    """
    Объединяет общие правила переговоров и рубрику кейса для парсеров / извлечения правил по пунктам.
    База Q&A (negotiation_qa_knowledge_base.md) сюда не включается — она не должна попадать в system LLM-оппонента.
    """
    counterpart = load_counterpart_prompt(case_code)
    case_prompt = load_case_prompt(case_code, contract_code)

    parts = []
    if counterpart:
        parts.append(counterpart.strip())
    if case_prompt:
        parts.append(case_prompt.strip())

    return "\n\n---\n\n".join(parts)


def _normalize_text(text: str) -> str:
    """Нормализует текст для сравнения."""
                        
    import string
    text = text.lower().strip()
    text = text.translate(str.maketrans("", "", string.punctuation + "«»""''"))
    return " ".join(text.split())


def _extract_general_rules(prompt_text: str) -> Dict[str, Any]:
    """
    Извлекает общие правила переговоров из системного промпта (ai_negotiation_system_prompt.md).
    
    Возвращает:
    - scoring_rules: правила оценки по шкале
    - winning_conditions: условия победы игрока
    - rejection_rules: правила отклонения
    - forbidden_phrases: запрещённые фразы
    """
    result = {
        "scoring_rules": {},
        "winning_conditions": [],
        "rejection_rules": [],
        "forbidden_phrases": [],
    }
    
    if not prompt_text:
        return result
    
                   
    score_patterns = [
        (r"(\d+)[–-](\d+)\s*баллов?\s*[—–:-]\s*([^,\n]+)", "range"),
        (r"score\s*>=?\s*(\d+).*?согласи", "threshold"),
    ]
    for pattern, ptype in score_patterns:
        for m in re.finditer(pattern, prompt_text, re.IGNORECASE):
            if ptype == "range":
                low, high, desc = m.groups()
                result["scoring_rules"][f"{low}-{high}"] = desc.strip()
    
                    
    win_patterns = [
        r"(?:победа|Status 2|согласие).*?(?:только|если|при)[^.]+\.",
        r"завершать переговоры победой.*?[^.]+\.",
    ]
    for pattern in win_patterns:
        for m in re.finditer(pattern, prompt_text, re.IGNORECASE):
            result["winning_conditions"].append(m.group(0).strip())
    
                        
    rejection_patterns = [
        r"(?:ЗАПРЕЩЕНО|Не пиши|Не говори)[^.]+\.",
        r"(?:укажи|указать)\s+(?:конкретн\w+)?\s*риск",
    ]
    for pattern in rejection_patterns:
        for m in re.finditer(pattern, prompt_text, re.IGNORECASE):
            result["rejection_rules"].append(m.group(0).strip())
    
    return result


def _extract_clause_rules(prompt_text: str, clause_number: str) -> Dict[str, Any]:
    """
    Извлекает правила для конкретного пункта из промпта.
    
    Возвращает:
    - etalon_formulations: список эталонных формулировок
    - correct_examples: примеры правильных ответов
    - incorrect_examples: примеры неправильных ответов
    - sufficient_explanations: достаточные обоснования
    - key_terms: ключевые слова для данного пункта
    - contract_position: позиция в договоре (текущая редакция)
    - guide_position: позиция по гайду (что требуется)
    - special_rules: специальные правила для пункта
    """
    result = {
        "etalon_formulations": [],
        "correct_examples": [],
        "incorrect_examples": [],
        "sufficient_explanations": [],
        "key_terms": [],
        "contract_position": "",
        "guide_position": "",
        "special_rules": [],
    }
    
    if not prompt_text:
        return result
    
                                                                                               
    pattern = rf"###\s*\d+\.\d+\.?\s*Пункт\s*{re.escape(clause_number)}[^\n]*\n(.*?)(?=###\s*\d+\.\d+\.?\s*Пункт|$)"
    match = re.search(pattern, prompt_text, re.DOTALL | re.IGNORECASE)
    
    if not match:
                                                            
        rules_match = re.search(
            rf"П\.\s*{re.escape(clause_number)}[^:]*:(.*?)(?=П\.\s*\d+\.\d+|$)",
            prompt_text,
            re.DOTALL | re.IGNORECASE
        )
        if rules_match:
                                                    
            rule_text = rules_match.group(1).strip()
            result["special_rules"].append(rule_text)
            return result
        return result
    
    section = match.group(1)
    
                        
    contract_match = re.search(
        r"\*\*В договоре\*\*[^:]*:\s*\n?(.*?)(?=\*\*В гайде|Эталонная|$)",
        section,
        re.DOTALL | re.IGNORECASE
    )
    if contract_match:
        result["contract_position"] = contract_match.group(1).strip()[:500]
    
                      
    guide_match = re.search(
        r"\*\*В гайде[^:]*:\*\*?\s*\n?(.*?)(?=Эталонная|Примеры|Вариант|$)",
        section,
        re.DOTALL | re.IGNORECASE
    )
    if guide_match:
        result["guide_position"] = guide_match.group(1).strip()[:500]
    
                                                                  
    etalon_matches = list(re.finditer(
        r"Эталонная редакция[^:\n]*(?:п\.\s*\d+\.\d+(?:\.\d+)?)?[:\s]*\n(.*?)(?=Объяснение|Пояснение|Примеры|Как объяснять|Фрейм|$)",
        section,
        re.DOTALL | re.IGNORECASE
    ))
    for em in etalon_matches:
        etalon_text = em.group(1).strip()
        for line in etalon_text.split("\n"):
            line = line.strip().lstrip("•-").strip()
            if not line:
                continue
            if line.startswith("**") or line.startswith("Объяснение") or line.startswith("Пояснение"):
                break
                                           
            line = re.sub(r"^\d+\.\d+(?:\.\d+)?\.?\s*", "", line)
            if len(line) > 5:
                result["etalon_formulations"].append(line.strip("«»\""))

                                                                                    
    for em in re.finditer(
        r"Эталонные\s+формулировки\s*:\s*([^\n]+)", section, re.IGNORECASE
    ):
        for part in re.findall(r"[«\"]([^»\"]+)[»\"]", em.group(1)):
            part = part.strip().strip("«»\"")
            if len(part) > 3 and part not in result["etalon_formulations"]:
                result["etalon_formulations"].append(part)
    
                                                     
    variant_blocks = re.findall(
        r"\*\*Вариант\s*\d+[^*]*\*\*[^\n]*\n(.*?)(?=\*\*Вариант|\*\*Согласие|Примеры|$)",
        section,
        re.DOTALL | re.IGNORECASE
    )
    for block in variant_blocks:
                                            
        etalon_in_var = re.search(r"Эталонная редакция[^:]*:\s*([^\n]+)", block, re.IGNORECASE)
        if etalon_in_var:
            text = etalon_in_var.group(1).strip().strip("«»\"")
            text = re.sub(r"^\d+\.\d+(?:\.\d+)?\.?\s*", "", text)
            if text and len(text) > 5 and text not in result["etalon_formulations"]:
                result["etalon_formulations"].append(text)
                                                                                                           
            for part in re.findall(r"[«\"]([^»\"]+)[»\"]", text):
                part = part.strip().strip("«»\"")
                if len(part) > 4 and part not in result["etalon_formulations"]:
                    result["etalon_formulations"].append(part)
                                    
        expl_in_var = re.search(r"Объяснение[^:]*:\s*([^\n]+)", block, re.IGNORECASE)
        if expl_in_var:
            result["sufficient_explanations"].append(expl_in_var.group(1).strip())
    
                                                      
    clause_text_matches = re.findall(
        rf"{re.escape(clause_number)}\.?\s+([^\n]+)",
        section,
        re.IGNORECASE
    )
    for m in clause_text_matches:
        text = m.strip().strip("«»\"()")
        if text and len(text) > 10 and text not in result["etalon_formulations"]:
            result["etalon_formulations"].append(text)
    
                                
    correct_section = re.search(
        r"Примеры правильных ответов[^:]*:?\s*(.*?)(?=Примеры неправильных|Недопустимый|ИИ-контрагент|Согласие игрока|$)",
        section,
        re.DOTALL | re.IGNORECASE
    )
    if correct_section:
        for line in correct_section.group(1).split("\n"):
            line = line.strip().lstrip("-•").strip()
            if line and len(line) > 10 and not line.startswith("Примеры") and not line.startswith("**"):
                line = line.strip("«»\"")
                result["correct_examples"].append(line)
    
                                  
    incorrect_section = re.search(
        r"Примеры неправильных ответов[^:]*:?\s*(.*?)(?=###|Эталонная|Как объяснять|ИИ-контрагент должен|Недопустимый ответ|$)",
        section,
        re.DOTALL | re.IGNORECASE
    )
    if incorrect_section:
        for line in incorrect_section.group(1).split("\n"):
            line = line.strip().lstrip("-•").strip()
                                                                                             
            if not line or len(line) <= 5:
                continue
            if line.startswith("Примеры") or line.startswith("**") or line.startswith("Ошибка"):
                continue
                                                                                                      
            lower_line = line.lower()
            if lower_line.startswith("если ") or lower_line.startswith("когда ") or lower_line.startswith("в случае"):
                continue
            line = line.strip("«»\"")
            result["incorrect_examples"].append(line)
    
                                                        
    explanation_patterns = [
        r"Достаточное\s+(?:обоснование|пояснение)[^:]*:\s*([^\n]+)",
        r"достаточно указать\s+([^\n]+)",
        r"Объяснение[^:]*:\s*([^\n]+)",
        r"Пояснение[^:]*:\s*([^\n]+)",
        r"поскольку\s+([^,.]+[,.])",
        r"потому что\s+([^,.]+[,.])",
    ]
    for pattern in explanation_patterns:
        for m in re.finditer(pattern, section, re.IGNORECASE):
            text = m.group(1).strip()
            if text and len(text) > 10 and text not in result["sufficient_explanations"]:
                result["sufficient_explanations"].append(text)
    
                                                                         
    special_patterns = [
        r"(?:возможны|допускается|ИИ должен принимать)[^\n.]+[.\n]",
        r"Недопустимый ответ[^:]*:[^\n]+",
        r"ИИ-контрагент[^.]+\.",
    ]
    for pattern in special_patterns:
        for m in re.finditer(pattern, section, re.IGNORECASE):
            text = m.group(0).strip()
            if text and len(text) > 20 and text not in result["special_rules"]:
                result["special_rules"].append(text)
    
                              
    key_term_patterns = [
        r"«([^»]+)»",
        r"риск\s+(?:в\s+)?([^,.]+)",
    ]
    for pattern in key_term_patterns:
        for m in re.finditer(pattern, section, re.IGNORECASE):
            text = m.group(1).strip()
            if text and 3 < len(text) < 100:
                result["key_terms"].append(text)
    
    return result


def get_clause_rules_from_prompt(case_code: str, clause_id: str, contract_code: str = "dogovor_PO") -> Dict[str, Any]:
    """
    Получает правила оценки для пункта из промптов кейса.
    Объединяет правила из ai_negotiation_system_prompt.md и рубрики кейса (ai_case_*_scoring_rubric.md).
    """
                           
    full_prompt = load_full_prompt(case_code, contract_code)
    
                                                                                 
    clause_number = clause_id.split("_")[0] if "_" in clause_id else clause_id
    number_match = re.match(r"(\d+\.\d+(?:\.\d+)?)", clause_id)
    if number_match:
        clause_number = number_match.group(1)
    
                                  
    clause_rules = _extract_clause_rules(full_prompt, clause_number)
    
                             
    general_rules = _extract_general_rules(full_prompt)
    clause_rules["general"] = general_rules
    
    return clause_rules


def get_all_clause_rules(case_code: str, contract_code: str = "dogovor_PO") -> Dict[str, Dict[str, Any]]:
    """
    Извлекает правила для всех пунктов из промптов.
    Возвращает словарь {clause_number: rules}.
    """
    full_prompt = load_full_prompt(case_code, contract_code)
    
                             
    clause_pattern = r"###\s*\d+\.\d+\.?\s*Пункт\s*(\d+\.\d+(?:\.\d+)?)"
    clause_numbers = re.findall(clause_pattern, full_prompt, re.IGNORECASE)
    
    result = {}
    for clause_num in set(clause_numbers):
        result[clause_num] = _extract_clause_rules(full_prompt, clause_num)
    
                             
    result["_general"] = _extract_general_rules(full_prompt)
    
    return result


def _strip_formulation_intro(text: str) -> str:
    """Убирает вводные фразы типа «Предлагаю изложить в редакции:», чтобы оставить только формулировку."""
    if not text or len(text.strip()) < 5:
        return (text or "").strip()
    t = text.strip()
    for pattern in (
        r"^Предлагаю изложить в редакции\s*[:\s]*",
        r"^Предлагаю в редакции\s*[:\s]*",
        r"^Изложить в редакции\s*[:\s]*",
        r"^В редакции\s*[:\s]*",
        r"^В следующей редакции\s*[:\s]*",
        r"^Редакция\s*[:\s]*",
        r"^Предлагаем\s*[:\s]*",
        r"^Предлагаю\s*[:\s]*",
    ):
        t = re.sub(pattern, "", t, flags=re.IGNORECASE)
    return t.strip().strip("\u00AB\u00BB\u0022\u0027\u201C\u201D\u2018\u2019\u201E")


def is_correct_formulation_by_prompt(
    player_text: str,
    case_code: str,
    clause_id: str,
    contract_code: str = "dogovor_PO"
) -> tuple[bool, str]:
    """
    Проверяет, является ли формулировка игрока правильной по промпту.
    
    Использует:
    - Эталонные формулировки из промпта
    - Примеры правильных ответов
    - Ключевые термины
    
    Возвращает (is_correct, matched_etalon).
    """
    rules = get_clause_rules_from_prompt(case_code, clause_id, contract_code)
                                                                                                                    
    player_clean = _strip_formulation_intro(player_text)
    player_normalized = _normalize_text(player_clean)
    
                                      
    for etalon in rules["etalon_formulations"]:
        etalon_normalized = _normalize_text(etalon)
        etalon_words = set(w for w in etalon_normalized.split() if len(w) >= 3)
        player_words = set(w for w in player_normalized.split() if len(w) >= 3)
        
                                                                  
        threshold = 0.6 if len(etalon_words) <= 5 else 0.4
        if etalon_words and len(etalon_words & player_words) >= max(2, len(etalon_words) * threshold):
            return True, etalon
        
                                   
        if len(etalon_normalized) >= 10:
            if etalon_normalized in player_normalized or player_normalized in etalon_normalized:
                return True, etalon
    
                                          
    for example in rules["correct_examples"]:
        example_normalized = _normalize_text(example)
        example_words = set(w for w in example_normalized.split() if len(w) >= 4)
        player_words = set(w for w in player_normalized.split() if len(w) >= 4)
        
        if example_words and len(example_words & player_words) >= min(3, len(example_words) * 0.4):
            return True, example
        
                   
        if len(example_normalized) > 15:
            if example_normalized in player_normalized or player_normalized in example_normalized:
                return True, example
    
                                
    for term in rules["key_terms"]:
        term_normalized = _normalize_text(term)
        if len(term_normalized) < 4:
            continue
                                           
        if term_normalized in player_normalized:
            return True, term
                                                                                     
        player_words = [w for w in player_normalized.split() if len(w) >= 2]
        if len(player_words) <= 4 and len(player_normalized) <= 50:
            if player_normalized in term_normalized:
                return True, term
                                               
            term_words = set(w for w in term_normalized.split() if len(w) >= 2)
            if term_words and len(set(player_words) & term_words) >= min(2, len(term_words)):
                return True, term
    
    return False, ""


def _calculate_formulation_score(
    player_text: str,
    rules: Dict[str, Any]
) -> tuple[int, str]:
    """
    Рассчитывает балл формулировки по 10-балльной шкале.
    
    Возвращает (score, reason).
    """
    player_normalized = _normalize_text(player_text)
    
                                            
    for etalon in rules["etalon_formulations"]:
        etalon_normalized = _normalize_text(etalon)
        if player_normalized == etalon_normalized:
            return 10, f"Точное совпадение с эталоном: {etalon[:50]}..."
        
        etalon_words = set(w for w in etalon_normalized.split() if len(w) >= 3)
        player_words = set(w for w in player_normalized.split() if len(w) >= 3)
        
        if etalon_words:
            overlap = len(etalon_words & player_words) / len(etalon_words)
            if overlap >= 0.9:
                return 9, f"Почти полное совпадение с эталоном"
            elif overlap >= 0.7:
                return 8, f"Близко к эталону"
            elif overlap >= 0.5:
                return 6, f"Частичное совпадение с эталоном"
    
                                          
    for example in rules["correct_examples"]:
        example_normalized = _normalize_text(example)
        example_words = set(w for w in example_normalized.split() if len(w) >= 4)
        player_words = set(w for w in player_normalized.split() if len(w) >= 4)
        
        if example_words:
            overlap = len(example_words & player_words) / len(example_words)
            if overlap >= 0.6:
                return 7, f"Совпадает с примером правильного ответа"
    
                                   
    for incorrect in rules["incorrect_examples"]:
        incorrect_normalized = _normalize_text(incorrect)
        if incorrect_normalized in player_normalized or player_normalized in incorrect_normalized:
            return 2, f"Совпадает с неправильным примером"
    
    return 5, "Не найдено точного совпадения"


def is_incorrect_formulation_by_prompt(
    player_text: str,
    case_code: str,
    clause_id: str,
    contract_code: str = "dogovor_PO"
) -> bool:
    """
    Проверяет, является ли формулировка игрока явно неправильной по промпту.
    
    Важно: ответ считается неправильным только если он ПОЛНОСТЬЮ соответствует неправильному примеру
    или является его точной копией. Частичное совпадение (когда неправильный пример является
    частью более длинного ответа) не считается неправильным.
    """
    rules = get_clause_rules_from_prompt(case_code, clause_id, contract_code)
    player_normalized = _normalize_text(player_text)
    player_words = set(w for w in player_normalized.split() if len(w) >= 3)
    
    for incorrect in rules["incorrect_examples"]:
        incorrect_normalized = _normalize_text(incorrect)
        incorrect_words = set(w for w in incorrect_normalized.split() if len(w) >= 3)
        
                                                    
        if player_normalized == incorrect_normalized:
            return True
        
                                                                                                       
        if player_normalized in incorrect_normalized and len(player_words) <= len(incorrect_words):
            return True
        
                                                                             
                                                                                                          
        if incorrect_words and incorrect_words.issubset(player_words):
                                                                                 
            extra_words = player_words - incorrect_words
                                                                                
            if len(extra_words) < 3:
                return True
    
    return False


def is_sufficient_explanation_by_prompt(
    explanation_text: str,
    case_code: str,
    clause_id: str,
    contract_code: str = "dogovor_PO"
) -> bool:
    """
    Проверяет, является ли пояснение игрока достаточным по промпту.
    
    Пояснение должно содержать причинно-следственную связь (маркеры: поскольку, потому что,
    так как, в связи, риск, офис, сотрудник и т.д.)
    """
    rules = get_clause_rules_from_prompt(case_code, clause_id, contract_code)
    explanation_normalized = _normalize_text(explanation_text)
    
                                                  
    explanation_markers = (
        "поскольку", "потому что", "так как", "в связи", "ввиду",
        "риск", "офис", "сотрудник", "деятельность", "страна", "убыток",
        "потер", "простой", "необходим", "важно", "критич", "ущерб",
        "несоразмер", "лимит", "ограничен", "период", "ip", "конфиденциальн",
        "данн", "умысл", "неосторожн", "акт", "дата", "срок", "неопределен",
        "уведомл", "отказ", "расторж", "односторонн", "суд", "гк",
        "рубеж", "предел", "разных точк", "разных стран", "рф и рк", "обеих стран",
    )
    has_explanation_marker = any(m in explanation_normalized for m in explanation_markers)
    if not has_explanation_marker:
        return False
    
                                                  
    for sufficient in rules.get("sufficient_explanations", []):
        sufficient_normalized = _normalize_text(sufficient)
        sufficient_words = set(w for w in sufficient_normalized.split() if len(w) >= 4)
        explanation_words = set(w for w in explanation_normalized.split() if len(w) >= 4)
        if sufficient_words and len(sufficient_words & explanation_words) >= 2:
            return True
    
                                                                                           
    for example in rules.get("correct_examples", []):
        example_normalized = _normalize_text(example)
                                                                      
        if any(m in example_normalized for m in explanation_markers):
            example_words = set(w for w in example_normalized.split() if len(w) >= 4)
            explanation_words = set(w for w in explanation_normalized.split() if len(w) >= 4)
            if example_words and len(example_words & explanation_words) >= 2:
                return True
    
                                                                                 
    if has_explanation_marker and len(explanation_normalized) >= 15:
        return True
    
    return False


def evaluate_player_response_by_prompt(
    player_text: str,
    case_code: str,
    clause_id: str,
    chat_history: List[Dict[str, Any]] | None = None,
    contract_code: str = "dogovor_PO"
) -> Dict[str, Any]:
    """
    Полная оценка ответа игрока по промпту кейса.
    
    Учитывает правила из ai_negotiation_system_prompt.md и рубрики кейса (ai_case_*_scoring_rubric.md):
    - Эталонные формулировки
    - Примеры правильных/неправильных ответов  
    - Достаточные обоснования
    - Специальные правила для пункта
    - Историю переговоров
    
    Возвращает:
    - has_formulation: есть ли правильная формулировка
    - has_explanation: есть ли достаточное пояснение
    - is_incorrect: является ли ответ явно неправильным
    - matched_etalon: подходящая эталонная формулировка
    - formulation_from_history: формулировка из истории (если в текущем сообщении нет)
    - score: оценка по 10-балльной шкале (0-10)
    - score_reason: причина оценки
    - special_rules: специальные правила для пункта
    """
    rules = get_clause_rules_from_prompt(case_code, clause_id, contract_code)
    
    result = {
        "has_formulation": False,
        "has_explanation": False,
        "is_incorrect": False,
        "matched_etalon": "",
        "formulation_from_history": "",
        "score": 5,
        "score_reason": "",
        "special_rules": rules.get("special_rules", []),
    }
    
                                  
    if is_incorrect_formulation_by_prompt(player_text, case_code, clause_id, contract_code):
        result["is_incorrect"] = True
        result["score"] = 2
        result["score_reason"] = "Совпадает с примером неправильного ответа"
        return result
    
                                       
    is_correct, matched = is_correct_formulation_by_prompt(player_text, case_code, clause_id, contract_code)
    result["has_formulation"] = is_correct
    result["matched_etalon"] = matched
    
                                                                                              
    if not is_correct and chat_history:
        for msg in reversed(chat_history):
            if msg.get("owner") != "player":
                continue
            msg_text = (msg.get("text") or msg.get("message") or "").strip()
            if not msg_text:
                continue
            hist_correct, hist_matched = is_correct_formulation_by_prompt(msg_text, case_code, clause_id, contract_code)
            if hist_correct:
                result["has_formulation"] = True
                result["formulation_from_history"] = hist_matched
                break
    
                                             
    result["has_explanation"] = is_sufficient_explanation_by_prompt(player_text, case_code, clause_id, contract_code)
    
                                                                                           
    if not result["has_explanation"] and chat_history:
        for msg in reversed(chat_history):
            if msg.get("owner") != "player":
                continue
            msg_text = (msg.get("text") or msg.get("message") or "").strip()
            if not msg_text:
                continue
            if is_sufficient_explanation_by_prompt(msg_text, case_code, clause_id, contract_code):
                result["has_explanation"] = True
                break
    
                       
    if result["has_formulation"] and result["has_explanation"]:
                                                 
        score, reason = _calculate_formulation_score(
            result["matched_etalon"] or result["formulation_from_history"] or player_text,
            rules
        )
        result["score"] = min(10, score + 1)                           
        result["score_reason"] = f"{reason}; есть пояснение"
    elif result["has_formulation"]:
                                           
        score, reason = _calculate_formulation_score(
            result["matched_etalon"] or result["formulation_from_history"] or player_text,
            rules
        )
        result["score"] = min(7, score)                                         
        result["score_reason"] = f"{reason}; нет пояснения"
    elif result["has_explanation"]:
                                           
        result["score"] = 5
        result["score_reason"] = "Есть пояснение, но нет конкретной формулировки"
    else:
                             
        result["score"] = 4
        result["score_reason"] = "Нет формулировки и пояснения"
    
    return result


def get_prompt_context_for_llm(case_code: str, clause_id: str, contract_code: str = "dogovor_PO") -> str:
    """
    Текстовый блок промптов для LLM отключён; правила для пост-обработки остаются в get_clause_rules_from_prompt.
    """
    _ = (case_code, clause_id, contract_code)
    return ""


def extract_clean_formulation(
    player_text: str,
    case_code: str,
    clause_id: str,
    contract_code: str = "dogovor_PO"
) -> str:
    """
    Извлекает чистую формулировку пункта из текста игрока, отделяя её от пояснения.
    
    Если игрок пишет "На территории всего мира, поскольку наши сотрудники могут пользоваться
    из разных точек мира", возвращает только "На территории всего мира".
    
    Логика:
    1. Ищем маркеры пояснения (поскольку, потому что, так как и т.д.)
    2. Отсекаем часть после маркера
    3. Возвращаем очищенную формулировку (без пояснения)
    """
    if not player_text or len(player_text.strip()) < 3:
        return ""
    
                                                   
    explanation_markers = [
        ", поскольку", " поскольку",
        ", потому что", " потому что",
        ", так как", " так как",
        ", в связи с", " в связи с",
        ", ввиду", " ввиду",
        ", из-за", " из-за",
        ", чтобы", " чтобы",
        ", для того", " для того",
        ". Это нужно", ". это нужно",
        ". Так мы", ". так мы",
        ". Наши", ". наши",
        ". У нас", ". у нас",
    ]
    
    text = player_text.strip()
    
                                                                               
    intro_patterns = [
        r"^Предлагаю изложить в следующей редакции[:\s]*",
        r"^Предлагаю изложить в новой редакции[:\s]*",
        r"^Предлагаю указать в следующей редакции[:\s]*",
        r"^Предлагаю изложить в редакции[:\s]*",
        r"^Предлагаю в редакции[:\s]*",
        r"^Изложить в следующей редакции[:\s]*",
        r"^Изложить в редакции[:\s]*",
        r"^В следующей редакции[:\s]*",
        r"^В редакции[:\s]*",
        r"^Редакция[:\s]*",
        r"^Предлагаем[:\s]*",
        r"^Предлагаю[:\s]*",
                                                                                             
        r"^хорошо,\s*давайте\s+тогда\s+укажем,\s*что\s+",
        r"^хорошо,\s*давайте\s+укажем,\s*что\s+",
        r"^хорошо,\s*тогда\s+укажем,\s*что\s+",
        r"^давайте\s+тогда\s+укажем,\s*что\s+",
        r"^давайте\s+укажем,\s*что\s+",
        r"^тогда\s+укажем,\s*что\s+",
        r"^укажем,\s*что\s+",
        r"^договорились,\s*укажем\s+",
        r"^договорились,\s*что\s+",
        r"^согласен,\s*пусть\s+будет\s+",
        r"^согласны,\s*пусть\s+будет\s+",
        r"^согласен,\s*укажем\s+",
        r"^согласны,\s*укажем\s+",
        r"^ладно,\s*давайте\s+",
        r"^ладно,\s*укажем\s+",
        r"^ок,\s*укажем\s+",
        r"^окей,\s*укажем\s+",
        r"^ок,\s*давайте\s+",
        r"^предлагаю\s+зафиксировать[:\s]*",
        r"^зафиксируем\s+следующее[:\s]*",
        r"^зафиксируем[:\s]*",
        r"^фиксируем\s+следующее[:\s]*",
        r"^пусть\s+в\s+договоре\s+будет\s+",
        r"^пусть\s+будет\s+",
        r"^в\s+договоре\s+укажем[:\s]*",
        r"^в\s+пункте\s+укажем[:\s]*",
    ]
    for pattern in intro_patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
                                            
    text = text.strip()
                            
    text = text.lstrip('\u00AB\u0022\u201E\u201C')
                           
    text = text.rstrip('\u00BB\u0022\u201D')
    
                                      
    lower_text = text.lower()
    earliest_pos = len(text)
    found_marker = False
    
    for marker in explanation_markers:
        pos = lower_text.find(marker.lower())
        if pos > 0 and pos < earliest_pos:
            earliest_pos = pos
            found_marker = True
    
    if found_marker:
                                          
        formulation_part = text[:earliest_pos].strip().rstrip(",.")
    else:
                                                           
        formulation_part = text.strip()
    
                                            
                         
    quote_chars = '\u00AB\u00BB\u0022\u0027\u201C\u201D\u2018\u2019\u201E'
    formulation_part = formulation_part.strip(quote_chars)
    
    if not formulation_part:
        return ""
    
                                                                                                          
    return strip_revision_meta_from_clause_draft(formulation_part.strip())
