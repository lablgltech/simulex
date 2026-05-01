"""Юнит-тесты сопоставления текста с A/B/C для моста этап 3→4."""

from services.stage4_text_match import hybrid_match_agreed_to_letter, normalize_for_match


def test_normalize_for_match_collapse():
    assert normalize_for_match("  А  б  ") == normalize_for_match("а б")


def test_hybrid_exact():
    texts = {"A": "foo", "B": "bar", "C": "baz"}
    letter, src, _meta = hybrid_match_agreed_to_letter("bar", texts)
    assert letter == "B"
    assert src == "exact"


def test_hybrid_normalized():
    texts = {"A": "По  всему  миру", "B": "другое", "C": "ещё"}
    letter, src, _meta = hybrid_match_agreed_to_letter("по всему миру", texts)
    assert letter == "A"
    assert src == "normalized"
