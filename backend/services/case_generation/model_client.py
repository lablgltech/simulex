"""Заглушка клиента модели для генерации кейса и анкеты."""

from __future__ import annotations


def get_case_generation_llm(**_kwargs):
    raise RuntimeError("Генерация через внешнюю модель отключена.")


def get_questionnaire_llm(**_kwargs):
    raise RuntimeError("Генерация через внешнюю модель отключена.")
