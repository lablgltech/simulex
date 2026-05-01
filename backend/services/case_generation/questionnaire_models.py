"""Pydantic-схема ответа анкеты для optional with_structured_output."""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class QuestionnaireOptionModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    value: str = ""
    label: str = ""


class QuestionnaireItemModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: Optional[str] = None
    prompt: str = ""
    question: Optional[str] = None
    text: Optional[str] = None
    title: Optional[str] = None
    choice_mode: str = "single"
    options: List[QuestionnaireOptionModel] = Field(default_factory=list)
    free_text_prompt: Optional[str] = None
    free_text_required: bool = False
    selection_required: bool = True
    help: Optional[str] = None


class QuestionnaireResponseModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    questionnaire_complete: bool = False
    rationale_short: str = ""
    questions: List[QuestionnaireItemModel] = Field(default_factory=list)
