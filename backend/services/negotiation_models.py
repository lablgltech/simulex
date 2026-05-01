"""
Структурированные модели для переговоров этапа 3.

Этот модуль определяет типизированные объекты для:
- входных данных игрока (PlayerOffer)
- результата оценки (OfferEvaluation)
- итогового решения по пункту (ClauseOutcome)

Цель: отделить детерминированную бизнес-логику от LLM-генерации,
устранить "дрейф решений" и обеспечить согласованность между
backend и frontend.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List


class OutcomeType(Enum):
    """Явный тип результата переговоров по пункту."""
    PENDING = "pending"                                                  
    ACCEPTED_PLAYER_CHANGE = "accepted_changed"                          
    CLAUSE_EXCLUDED = "clause_excluded"                                                   
    ACCEPTED_COUNTERPARTY = "accepted_counterparty"                                       
    KEPT_ORIGINAL = "kept_original"                                                                    
    CLOSED_NO_AGREEMENT = "closed_no_agreement"                                               
    ESCALATED = "escalated"                                                         


class DecisionReason(Enum):
    """Причина решения backend (для отладки и прозрачности)."""
    FORMULATION_AND_EXPLANATION_OK = "formulation_and_explanation_ok"
    FORMULATION_OK_NO_EXPLANATION = "formulation_ok_no_explanation"
    NO_FORMULATION = "no_formulation"
    FORMULATION_NOT_ACCEPTABLE = "formulation_not_acceptable"
    PLAYER_AGREED_WITH_COUNTERPARTY = "player_agreed_with_counterparty"
    REPLY_LIMIT_REACHED = "reply_limit_reached"
    PATIENCE_EXHAUSTED = "patience_exhausted"
    INSULT_DETECTED = "insult_detected"
    LLM_AGREEMENT = "llm_agreement"
    LLM_REJECTION = "llm_rejection"


@dataclass
class PlayerOffer:
    """Нормализованные данные хода игрока."""
    raw_text: str                                                              
    formulation_text: str = ""                                               
    explanation_text: str = ""                                         
    has_formulation: bool = False                                     
    has_explanation: bool = False                                                 
    near_expected_formulation: bool = False                                       
    accepted_counterparty_offer: bool = False                                                
    from_history: bool = False                                                           
    clause_id: str = ""
    action: str = "change"


@dataclass
class OfferEvaluation:
    """Результат оценки предложения игрока (детерминированный + LLM)."""
    score: float = 50.0                                       
    has_formulation: bool = False
    has_explanation: bool = False
    near_expected: bool = False
    llm_message: str = ""                                                               
    llm_agrees: bool = False                                                        
    decision_reason: DecisionReason = DecisionReason.NO_FORMULATION


@dataclass
class ClauseOutcome:
    """Итоговое решение по пункту договора."""
    outcome_type: OutcomeType = OutcomeType.PENDING
    decision_reason: DecisionReason = DecisionReason.NO_FORMULATION
    final_replacement_text: Optional[str] = None                                   
    clause_excluded: bool = False                                                                         
    bot_message: str = ""                                                  
    score: float = 50.0
    chat_complete: bool = False                                              
    next_status: int = 1                                                               


def normalize_player_offer(
    raw_text: str,
    new_clause_text: str,
    clause_data: dict,
    chat_history: list,
    action: str = "change",
) -> PlayerOffer:
    """
    Извлекает из сообщения игрока формулировку и пояснение.
    Если формулировка не найдена в текущем сообщении, ищет в истории чата.
    """
    from services.bot_logic import (
        _strip_intro_phrases,
        _is_near_expected_formulation,
        _is_substantive_justification,
        _looks_like_only_formulation,
        _player_agreed_with_counterpart,
        _extract_core_formulation,
        _text_contains_formulation_wrapper,
        _is_same_as_contract_text,
    )

    clause_id = clause_data.get("id") or clause_data.get("code") or ""
    offer = PlayerOffer(
        raw_text=raw_text.strip(),
        clause_id=str(clause_id),
        action=action,
    )

                                                   
    if _player_agreed_with_counterpart(raw_text, chat_history):
        offer.accepted_counterparty_offer = True
        offer.has_explanation = True                                                 
        return offer

                            
    candidate_text = (new_clause_text or "").strip()
    if candidate_text and _is_same_as_contract_text(candidate_text, clause_data):
        candidate_text = ""                                                  

    if not candidate_text:
                                     
        if _text_contains_formulation_wrapper(raw_text):
            candidate_text = _extract_core_formulation(raw_text)
        elif _is_near_expected_formulation(raw_text, clause_data, use_similarity=True):
            candidate_text = _strip_intro_phrases(raw_text)

    if not candidate_text and chat_history:
                                             
        for msg in reversed(chat_history):
            if msg.get("owner") != "player":
                continue
            if msg.get("clauseId") != str(clause_id) and msg.get("clauseId") != clause_id:
                continue
            prev_text = (msg.get("text") or "").strip()
            if not prev_text or len(prev_text) < 10:
                continue
            if _is_near_expected_formulation(prev_text, clause_data, use_similarity=True):
                candidate_text = _extract_core_formulation(prev_text)
                offer.from_history = True
                break
            if _text_contains_formulation_wrapper(prev_text):
                core = _extract_core_formulation(prev_text)
                if core and _is_near_expected_formulation(core, clause_data, use_similarity=False):
                    candidate_text = core
                    offer.from_history = True
                    break

    if candidate_text and len(candidate_text) >= 5:
        offer.formulation_text = candidate_text
        offer.has_formulation = True
        offer.near_expected_formulation = _is_near_expected_formulation(candidate_text, clause_data, use_similarity=True)

                         
    if _is_substantive_justification(raw_text):
        offer.has_explanation = True
                                                             
        offer.explanation_text = raw_text.strip()

                                                           
    if offer.has_formulation and not offer.has_explanation:
        if not _looks_like_only_formulation(raw_text, clause_data):
                                               
            offer.has_explanation = _is_substantive_justification(raw_text)

    return offer


def evaluate_offer_deterministically(
    offer: PlayerOffer,
    clause_data: dict,
    bot_reply_count: int,
    max_replies: int = 4,
    patience: int = 100,
) -> OfferEvaluation:
    """
    Детерминированная оценка предложения игрока по правилам кейса.
    Не вызывает LLM — только rule-based логика.
    """
    evaluation = OfferEvaluation()

    evaluation.has_formulation = offer.has_formulation
    evaluation.has_explanation = offer.has_explanation
    evaluation.near_expected = offer.near_expected_formulation

                                                 
    if offer.accepted_counterparty_offer:
        evaluation.score = 90.0
        evaluation.llm_agrees = True
        evaluation.decision_reason = DecisionReason.PLAYER_AGREED_WITH_COUNTERPARTY
        return evaluation

                      
    if not offer.has_formulation:
        evaluation.score = 30.0
        evaluation.decision_reason = DecisionReason.NO_FORMULATION
        return evaluation

                                               
    if not offer.near_expected_formulation:
        evaluation.score = 40.0
        evaluation.decision_reason = DecisionReason.FORMULATION_NOT_ACCEPTABLE
        return evaluation

                                                     
    if not offer.has_explanation:
        evaluation.score = 60.0
        evaluation.decision_reason = DecisionReason.FORMULATION_OK_NO_EXPLANATION
        return evaluation

                                                  
    evaluation.score = 85.0
    evaluation.llm_agrees = True
    evaluation.decision_reason = DecisionReason.FORMULATION_AND_EXPLANATION_OK
    return evaluation


def determine_clause_outcome(
    offer: PlayerOffer,
    evaluation: OfferEvaluation,
    clause_data: dict,
    bot_reply_count: int,
    patience: int,
    max_replies: int = 4,
    llm_message: str = "",
    llm_agrees: bool = False,
) -> ClauseOutcome:
    """
    Определяет итоговый результат по пункту на основе оценки.
    Это единственная точка принятия решения — никакого "дрейфа".
    """
    from services.document_service import ClauseStatus

    outcome = ClauseOutcome()
    outcome.score = evaluation.score
    outcome.decision_reason = evaluation.decision_reason

                                     
    THRESHOLD_AGREEMENT = 80.0

                                     
    if offer.accepted_counterparty_offer:
        outcome.outcome_type = OutcomeType.ACCEPTED_COUNTERPARTY
        outcome.chat_complete = True
        outcome.next_status = int(ClauseStatus["ACCEPTED_BOT"])
        outcome.bot_message = llm_message or "Хорошо, фиксируем в такой редакции."
                                                                        
        return outcome

                                                                                   
                                                               
    if bot_reply_count >= max_replies:
        if evaluation.score >= THRESHOLD_AGREEMENT:
            outcome.outcome_type = OutcomeType.ACCEPTED_PLAYER_CHANGE
            outcome.chat_complete = True
            outcome.next_status = int(ClauseStatus["CHANGED"])
            outcome.final_replacement_text = offer.formulation_text or None
            outcome.bot_message = llm_message or "Принимаем вашу редакцию."
            outcome.decision_reason = DecisionReason.REPLY_LIMIT_REACHED
            return outcome
        else:
                                                    
            outcome.outcome_type = OutcomeType.PENDING
            outcome.chat_complete = False
            outcome.next_status = int(ClauseStatus["SELECTED"])
            outcome.bot_message = (
                llm_message or
                "Поясните, пожалуйста, почему вы предлагаете именно такую редакцию."
            )
            outcome.decision_reason = DecisionReason.REPLY_LIMIT_REACHED
            return outcome

                                                                                            
                                 
    if patience <= 0 and bot_reply_count >= 1:
        if offer.near_expected_formulation and not offer.has_explanation:
            outcome.outcome_type = OutcomeType.PENDING
            outcome.chat_complete = False
            outcome.next_status = int(ClauseStatus["SELECTED"])
            outcome.bot_message = (
                llm_message or
                "Поясните, пожалуйста, почему для вас важна именно такая формулировка."
            )
            outcome.decision_reason = DecisionReason.PATIENCE_EXHAUSTED
            return outcome
        outcome.outcome_type = OutcomeType.CLOSED_NO_AGREEMENT
        outcome.chat_complete = True
        outcome.next_status = int(ClauseStatus["SELECTED"])
        outcome.decision_reason = DecisionReason.PATIENCE_EXHAUSTED
        outcome.bot_message = (
            llm_message or
            "Думаю, по этому пункту мы достаточно обсудили. Давайте перейдём к следующему."
        )
        return outcome

                                         
    if evaluation.score >= THRESHOLD_AGREEMENT:
        outcome.outcome_type = OutcomeType.ACCEPTED_PLAYER_CHANGE
        outcome.chat_complete = True
        outcome.next_status = int(ClauseStatus["CHANGED"])
        outcome.final_replacement_text = offer.formulation_text or None
        outcome.bot_message = llm_message or "Принимаем вашу редакцию."
        return outcome

                                                  
    if evaluation.decision_reason == DecisionReason.FORMULATION_OK_NO_EXPLANATION:
        outcome.outcome_type = OutcomeType.PENDING
        outcome.chat_complete = False
        outcome.next_status = int(ClauseStatus["SELECTED"])
        outcome.bot_message = (
            llm_message or
            "Редакция понятна. Поясните, пожалуйста, почему вы предлагаете именно такую формулировку."
        )
        return outcome

                                                      
    outcome.outcome_type = OutcomeType.PENDING
    outcome.chat_complete = False
    outcome.next_status = int(ClauseStatus["SELECTED"])
    outcome.bot_message = (
        llm_message or
        "Предложите, пожалуйста, конкретную редакцию пункта и кратко обоснуйте её."
    )
    return outcome
