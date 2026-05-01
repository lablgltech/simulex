"""
Сервис косинусного сходства для сравнения формулировок.

Используется как дополнительный сигнал для определения,
близка ли предложенная редакция к эталонным формулировкам.

Архитектура:
- Основная логика (rule-based) остаётся в bot_logic._is_near_expected_formulation
- Cosine similarity добавляет "мягкое" сравнение для перефразированных формулировок
- Результат комбинируется: rule-based имеет приоритет, cosine — подстраховка

Пороги:
- >= 0.85: почти идентичные формулировки
- >= 0.70: семантически близкие (перефразирование)
- < 0.70: разные по смыслу
- пояснение к эталону: по умолчанию >= 0.72 (см. THRESHOLD_EXPLANATION_RELEVANCE)
"""

from __future__ import annotations

import os
import re
import logging
from typing import List, Optional, Sequence, Tuple
from functools import lru_cache

logger = logging.getLogger(__name__)

                                                                  
_SIMILARITY_ENABLED = True
_model = None
_embeddings_cache: dict = {}

                 
THRESHOLD_NEAR_MATCH = 0.85                     
THRESHOLD_SEMANTIC_MATCH = 0.70                       
THRESHOLD_EXPLANATION_RELEVANCE = 0.72                                                                      
THRESHOLD_BOT_DEDUP = 0.80                         


def _get_model():
    """Ленивая загрузка модели sentence-transformers."""
    global _model, _SIMILARITY_ENABLED
    
    if _model is not None:
        return _model
    
    if not _SIMILARITY_ENABLED:
        return None
    
    try:
        from sentence_transformers import SentenceTransformer
                                                           
        model_name = os.environ.get(
            "SIMILARITY_MODEL",
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
        )
        logger.info(f"Loading similarity model: {model_name}")
        _model = SentenceTransformer(model_name)
        logger.info("Similarity model loaded successfully")
        return _model
    except ImportError:
        logger.warning("sentence-transformers not installed, cosine similarity disabled")
        _SIMILARITY_ENABLED = False
        return None
    except Exception as e:
        logger.warning(f"Failed to load similarity model: {e}")
        _SIMILARITY_ENABLED = False
        return None


def _get_embedding(text: str):
    """Получить embedding для текста (с кешированием)."""
    if not text or not _SIMILARITY_ENABLED:
        return None
    
    text_normalized = text.strip().lower()
    if text_normalized in _embeddings_cache:
        return _embeddings_cache[text_normalized]
    
    model = _get_model()
    if model is None:
        return None
    
    try:
        embedding = model.encode(text_normalized, convert_to_numpy=True)
        _embeddings_cache[text_normalized] = embedding
        return embedding
    except Exception as e:
        logger.warning(f"Failed to encode text: {e}")
        return None


def _levenshtein_distance(a: str, b: str) -> int:
    """Расстояние Левенштейна (для коротких формулировок пунктов договора)."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        ai = a[i - 1]
        for j in range(1, lb + 1):
            cur[j] = min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (ai != b[j - 1]),
            )
        prev = cur
    return prev[lb]


def normalized_levenshtein_ratio(a: str, b: str) -> float:
    """Сходство 0..1 на основе нормализованного расстояния (устойчивость к опечаткам)."""
    a = (a or "").strip()
    b = (b or "").strip()
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    d = _levenshtein_distance(a, b)
    return 1.0 - d / max(len(a), len(b))


def strings_match_with_typo_tolerance(
    candidate: str,
    reference: str,
    min_ratio: float = 0.86,
) -> bool:
    """
    Совпадение с допуском опечаток для любого пункта переговоров (без ML и без difflib.SequenceMatcher).
    Вызыватель обычно передаёт уже lower() и схлопнутые пробелы.
    """
    ca = " ".join((candidate or "").lower().split())
    cb = " ".join((reference or "").lower().split())
    if not ca or not cb:
        return False
    if ca == cb:
        return True
    if len(cb) < 5:
        return cb in ca or ca in cb
                                                                     
    if abs(len(ca) - len(cb)) > max(len(cb) // 3, 14):
        return False
    return normalized_levenshtein_ratio(ca, cb) >= min_ratio


def etalon_phrase_appears_with_typo_tolerance(
    text_norm: str,
    phrase_norm: str,
    min_ratio: float = 0.88,
) -> bool:
    """
    Короткая эталонная подстрока (etalon_phrases): ищем вхождение с допуском опечаток по скользящему окну.
    """
    t = " ".join((text_norm or "").lower().split())
    p = " ".join((phrase_norm or "").lower().split())
    if not t or not p or len(p) < 6:
        return p in t if p else False
    if p in t:
        return True
    lp = len(p)
    max_win = min(len(t), lp + 10)
    min_win = max(lp - 6, 4)
    for win_len in range(min_win, max_win + 1):
        if win_len > len(t):
            break
        for i in range(0, len(t) - win_len + 1):
            w = t[i : i + win_len]
            if normalized_levenshtein_ratio(w, p) >= min_ratio:
                return True
    return False


def compute_similarity(text1: str, text2: str) -> float:
    """
    Вычисляет косинусное сходство между двумя текстами.
    
    Возвращает:
    - float от 0.0 до 1.0
    - 0.0 если модель не загружена или тексты пусты
    """
    if not text1 or not text2:
        return 0.0
    
    emb1 = _get_embedding(text1)
    emb2 = _get_embedding(text2)
    
    if emb1 is None or emb2 is None:
        return 0.0
    
    try:
        from sklearn.metrics.pairwise import cosine_similarity
        import numpy as np
        
        sim = cosine_similarity(
            emb1.reshape(1, -1),
            emb2.reshape(1, -1)
        )[0][0]
        return float(sim)
    except Exception as e:
        logger.warning(f"Failed to compute similarity: {e}")
        return 0.0


def max_similarity_to_references(text: str, references: Sequence[str]) -> float:
    """Максимальное косинусное сходство текста с любым из эталонов (0.0 при пусто / модель недоступна)."""
    if not text or not references:
        return 0.0
    best = 0.0
    for ref in references:
        if not ref or not str(ref).strip():
            continue
        best = max(best, compute_similarity(text, str(ref).strip()))
    return best


def pick_bank_variant_for_context(
    player_text: str,
    variants: List[str],
    avoid_texts: Optional[List[str]] = None,
    repeat_threshold: float = THRESHOLD_BOT_DEDUP,
) -> Optional[str]:
    """
    Выбор варианта из банка фраз: ближе к реплике игрока, далее от недавних реплик бота.
    Возвращает None, если список пуст или similarity-модель недоступна (вызывающий код делает random.choice).
    """
    avoid_texts = avoid_texts or []
    clean_variants = [str(v).strip() for v in variants if v and str(v).strip()]
    if not clean_variants:
        return None
    if not _get_model():
        return None
    pt = (player_text or "").strip()
    best_v: Optional[str] = None
    best_score = -1e9
    for v in clean_variants:
        sim_player = compute_similarity(pt, v) if pt else 0.35
        penalty = 0.0
        for prev in avoid_texts:
            p = (prev or "").strip()
            if not p:
                continue
            if compute_similarity(v, p) >= repeat_threshold:
                penalty += 0.55
        total = sim_player - penalty
        if total > best_score:
            best_score = total
            best_v = v
    return best_v


def _text_looks_like_narrative_explanation_anchor(text: str) -> bool:
    """Короткие строки из ideal_options — формулировки пункта, не эталон пояснения."""
    t = (text or "").strip()
    if len(t) < 42:
        return False
    low = t.lower()
    return any(
        frag in low
        for frag in (
            "поскольку",
            "потому что",
            "так как ",
            "так как,",
            "в связи с",
            "обоснован",
            "дублир",
            "противореч",
            "избыточ",
            "неопределён",
            "неопределен",
            "риск",
            "убытк",
            "офис",
            "сотрудник",
            "за рубеж",
            "в других странах",
        )
    )


def explanation_reference_texts_from_case(clause_data: dict | None) -> List[str]:
    """
    Эталонные пояснения из кейса: ``rules.explanation_reference_texts``
    или то же поле на **корне пункта** gameData (обратная совместимость со старым JSON).
    """
    if not clause_data or not isinstance(clause_data, dict):
        return []
    rules = clause_data.get("rules") or {}
    out: List[str] = []
    seen: set[str] = set()

    def take_from(raw) -> None:
        if not isinstance(raw, list):
            return
        for x in raw:
            t = str(x).strip()
            if len(t) < 14:
                continue
            k = t.lower()
            if k in seen:
                continue
            seen.add(k)
            out.append(t)

    take_from(rules.get("explanation_reference_texts"))
    if out:
        return out
    take_from(clause_data.get("explanation_reference_texts"))
    return out


def explanation_min_similarity_from_case(clause_data: dict | None) -> float:
    """Порог 0–100 для эталонных пояснений; по умолчанию 70. См. ``rules`` или корень пункта."""
    if not clause_data or not isinstance(clause_data, dict):
        return 70.0
    rules = clause_data.get("rules") or {}
    for src in (rules, clause_data):
        v = src.get("explanation_min_similarity_0_100")
        if v is None:
            continue
        try:
            return max(0.0, min(100.0, float(v)))
        except (TypeError, ValueError):
            continue
    return 70.0


def collect_explanation_reference_corpus(clause_data: dict) -> List[str]:
    """
    Корпус для шкалы 0–100: семантическая близость к **эталонным пояснениям** из кейса.

    В gameData эталон задаётся полем ``rules.explanation_reference_texts`` (основной
    источник истины). Пока оно непустое — в корпус попадают **только** эти строки
    (few_shot / correct_examples не размывают порог).

    Если ``explanation_reference_texts`` пусто — fallback: few_shot_dialogues[].player
    и развёрнутые correct_examples (обратная совместимость и тестовые фикстуры).

    ``incorrect_examples`` в JSON — по смыслу кейса «далеко от эталона» (часто черновики
    пункта, а не пояснения); в этот корпус они **не** входят. Отсечение «ближе к неправильному»
    можно делать отдельно через ``collect_incorrect_example_corpus`` + правило порога.
    """
    if not clause_data or not isinstance(clause_data, dict):
        return []
    explicit = explanation_reference_texts_from_case(clause_data)
    if explicit:
        return explicit
    rules = clause_data.get("rules") or {}
    out: List[str] = []
    seen: set[str] = set()

    def add(s: str) -> None:
        t = (s or "").strip()
        if len(t) < 14:
            return
        k = t.lower()
        if k in seen:
            return
        seen.add(k)
        out.append(t)
    for d in clause_data.get("few_shot_dialogues") or []:
        if isinstance(d, dict):
            add((d.get("player") or "").strip())
    for ex in clause_data.get("correct_examples") or []:
        item = ex.get("text", ex) if isinstance(ex, dict) else ex
        t = str(item).strip()
        if _text_looks_like_narrative_explanation_anchor(t) or len(t) >= 56:
            add(t)
    return out


def collect_incorrect_example_corpus(clause_data: dict) -> List[str]:
    """
    Тексты из incorrect_examples (обычно заведомо неверные формулировки / ответы по пункту).

    Для пояснений игрока можно сравнивать max_sim к эталону и к этому списку: если
    «ближе к неправильному» — отклонять (см. ``explanation_incorrect_margin`` в rules).
    """
    if not clause_data or not isinstance(clause_data, dict):
        return []
    out: List[str] = []
    seen: set[str] = set()
    for ex in clause_data.get("incorrect_examples") or []:
        item = ex.get("text", ex) if isinstance(ex, dict) else ex
        t = str(item).strip()
        if len(t) < 10:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
    return out


_TERM_142_EXPL_STOPWORDS = frozenset(
    """
    и в на по к с у о об от до за из над под при без ни не да но а же ли бы лишь только
    то как это того ещё еще уже там тут вот раз мне нам вам им ему ей им поскольку потому
    так в связи ввиду или либо же бы
    """.split()
)


def term_142_explanation_is_exclusive_rights_lexicon_only(text: str) -> bool:
    """
    П. 1.4.2: пояснение состоит только из слов вокруг «исключитель*» и короткого «прав*»
    (в т.ч. «исключительных прав», «исключительное право»), без иных содержательных слов.

    Такой текст не считается содержательным эталонным пояснением: семантический скор
    ограничивается (см. ``explanation_reference_score_0_100``), близость по корпусу — «далеко».
    """
    raw = (text or "").strip()
    if len(raw) < 4 or len(raw) > 140:
        return False
    low = raw.lower().replace("ё", "е")
    low = re.sub(r"[^\wа-яё\s]+", " ", low)
    low = re.sub(r"\s+", " ", low).strip()
    if not low:
        return False
    token_ok = re.compile(
        r"^(исключительн\w*|исключитель\w{0,10}|прав(о|а|ом|ам|ах|е|ами|у)?|прав)$",
        re.IGNORECASE,
    )
    has_exclusive_stem = False
    for w in low.split():
        if w in _TERM_142_EXPL_STOPWORDS or len(w) < 2:
            continue
        if not token_ok.match(w):
            return False
        if w.startswith("исключитель") or re.match(r"^прав", w):
            has_exclusive_stem = True
    return bool(has_exclusive_stem)


def explanation_reference_score_0_100(player_text: str, clause_data: dict) -> Optional[float]:
    """
    Макс. косинусное сходство пояснения игрока с любым эталонным пояснением, шкала 0.0–100.0.
    None — нет корпуса или выключены эмбеддинги.

    П. 1.4.2: если пояснение — только лексика «исключитель*» / «прав*» без других слов,
    скор ограничивается 69.0 (при типичном пороге 70 в ``is_real_explanation`` не считается близким к эталону).
    """
    corpus = collect_explanation_reference_corpus(clause_data)
    if not corpus or not player_text or not str(player_text).strip():
        return None
    if not is_enabled():
        return None
    m = max_similarity_to_references(str(player_text).strip(), tuple(corpus))
    score = round(float(max(0.0, min(1.0, m))) * 100.0, 1)
    if str((clause_data or {}).get("id") or "").strip() == "1.4.2_term":
        if term_142_explanation_is_exclusive_rights_lexicon_only(str(player_text)):
                                                                                                                       
            score = min(score, 69.0)
    return score


def collect_explanation_semantic_references(clause_data: dict) -> List[str]:
    """
    Тексты для сравнения именно ПОЯСНЕНИЯ с эталоном (не редакция пункта из ideal_options).

    Приоритет: topic_relevance.reference_phrases → примеры из few_shot_dialogues (игрок)
    и развёрнутые correct_examples → длинный guide_summary.
    """
    refs: List[str] = []
    rules = clause_data.get("rules") or {}
    ev = rules.get("explanation_validation") or {}
    tr = ev.get("topic_relevance") or {}
    for p in tr.get("reference_phrases") or []:
        ps = str(p).strip()
        if len(ps) >= 4:
            refs.append(ps)
    if refs:
        return refs
    for d in clause_data.get("few_shot_dialogues") or []:
        if not isinstance(d, dict):
            continue
        pl = (d.get("player") or "").strip()
        if len(pl) >= 26:
            refs.append(pl)
    for ex in clause_data.get("correct_examples") or []:
        item = ex.get("text", ex) if isinstance(ex, dict) else ex
        t = str(item).strip()
        if _text_looks_like_narrative_explanation_anchor(t):
            refs.append(t)
    gs = clause_data.get("guide_summary")
    if isinstance(gs, str) and len(gs.strip()) >= 48:
        refs.append(gs.strip())
    return refs


def _legacy_broad_explanation_refs(clause_data: dict) -> List[str]:
    """Узкий fallback, если нет reference_phrases / примеров: без коротких ideal_options."""
    refs: List[str] = []
    gs = clause_data.get("guide_summary")
    if isinstance(gs, str) and gs.strip():
        refs.append(gs.strip())
    title = clause_data.get("title")
    if isinstance(title, str) and title.strip():
        refs.append(title.strip())
    for key in ("correct_examples",):
        items = clause_data.get(key) or []
        if isinstance(items, list):
            for item in items:
                t = (item.get("text", item) if isinstance(item, dict) else str(item)).strip()
                if _text_looks_like_narrative_explanation_anchor(t):
                    refs.append(t)
    for key in ("correct_example",):
        v = clause_data.get(key)
        if isinstance(v, str) and _text_looks_like_narrative_explanation_anchor(v):
            refs.append(v.strip())
    return refs


def is_explanation_relevant_to_clause(
    explanation_text: str,
    clause_data: dict,
    threshold: float = THRESHOLD_EXPLANATION_RELEVANCE,
) -> bool:
    """
    Семантическая близость пояснения к эталонным пояснениям / фразам темы (не к тексту пункта договора).

    Не смешивает ideal_options (короткие редакции) с обоснованием — иначе общие фразы
    получают ложно высокий скор к «По всему миру» и т.п.
    """
    if not explanation_text or not clause_data:
        return False
    rules = clause_data.get("rules") or {}
    tr = (rules.get("explanation_validation") or {}).get("topic_relevance") or {}
    try:
        topic_thr = float(tr.get("similarity_threshold") or 0)
    except (TypeError, ValueError):
        topic_thr = 0.0
    refs = collect_explanation_semantic_references(clause_data)
    eff_thr = max(float(threshold), 0.72)
    if tr.get("required") and topic_thr > 0:
        eff_thr = max(eff_thr, topic_thr)
    if refs:
        return max_similarity_to_references(explanation_text.strip(), tuple(refs)) >= eff_thr
    legacy = _legacy_broad_explanation_refs(clause_data)
    if not legacy:
        return False
    return max_similarity_to_references(explanation_text.strip(), tuple(legacy)) >= eff_thr


def find_best_match(
    candidate: str,
    references: List[str],
    threshold: float = THRESHOLD_SEMANTIC_MATCH,
) -> Tuple[Optional[str], float]:
    """
    Находит наиболее похожую формулировку из списка эталонов.
    
    Args:
        candidate: текст игрока
        references: список эталонных формулировок
        threshold: минимальный порог сходства
    
    Returns:
        (best_match, score) — лучшее совпадение и его score,
        или (None, 0.0) если ничего не подошло
    """
    if not candidate or not references:
        return None, 0.0
    
    best_match = None
    best_score = 0.0
    
    for ref in references:
        if not ref:
            continue
        score = compute_similarity(candidate, ref)
        if score > best_score:
            best_score = score
            best_match = ref
    
    if best_score >= threshold:
        return best_match, best_score
    
    return None, best_score


def is_semantically_near_expected(
    player_text: str,
    clause_data: dict,
    threshold: float = THRESHOLD_SEMANTIC_MATCH,
) -> Tuple[bool, float, Optional[str]]:
    """
    Проверяет, близок ли текст игрока к эталонным формулировкам.
    
    Собирает все эталоны из clause_data:
    - ideal_option
    - ideal_options
    - etalon_phrases
    - correct_examples
    
    Returns:
        (is_near, best_score, matched_reference)
    """
    if not player_text or not clause_data:
        return False, 0.0, None
    
                          
    references: List[str] = []
    
    ideal = clause_data.get("ideal_option")
    if isinstance(ideal, str) and ideal.strip():
        references.append(ideal.strip())
    
    for key in ("ideal_options", "etalon_phrases", "correct_examples"):
        items = clause_data.get(key) or []
        if isinstance(items, list):
            for item in items:
                text = (item.get("text", item) if isinstance(item, dict) else str(item)).strip()
                if text and len(text) >= 5:
                    references.append(text)
    
    correct_ex = clause_data.get("correct_example")
    if isinstance(correct_ex, str) and correct_ex.strip():
        references.append(correct_ex.strip())
    
    if not references:
        return False, 0.0, None
    
    matched, score = find_best_match(player_text, references, threshold)
    return matched is not None, score, matched


def clear_cache():
    """Очистить кеш embeddings (для тестов)."""
    global _embeddings_cache
    _embeddings_cache = {}


def embedding_dependencies_installed() -> bool:
    """
    Быстрая проверка без загрузки весов модели (для лога при старте API).

    Если False — порог ``explanation_min_similarity_0_100`` к эталону не применяется,
    остаётся запасной путь по маркерам.
    """
    try:
        import sentence_transformers              

        return True
    except ImportError:
        return False


def is_enabled() -> bool:
    """Проверить, включён ли сервис cosine similarity."""
    return _SIMILARITY_ENABLED and _get_model() is not None
