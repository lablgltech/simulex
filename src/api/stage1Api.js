import { API_URL, getAuthHeaders } from './config';
import { safeFetch } from './errorHandler';

const base = () => API_URL.replace(/\/$/, '') + '/stage1';

/** Оценка качества заметки для брифа (этап 1) */
export const stage1InsightAPI = {
  evaluate: async ({
    insight_text,
    attribute_id,
    attribute_title,
    reference_insights,
    document_snippet,
    case_id,
    requested_document_ids,
    all_attributes,
    existing_insights_by_attribute,
  }) =>
    safeFetch(`${base()}/insight/evaluate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        insight_text,
        attribute_id: attribute_id ?? null,
        attribute_title: attribute_title ?? null,
        reference_insights: reference_insights ?? null,
        document_snippet: document_snippet ?? null,
        case_id: case_id ?? null,
        requested_document_ids: requested_document_ids ?? null,
        all_attributes: all_attributes ?? null,
        existing_insights_by_attribute: existing_insights_by_attribute ?? null,
      }),
    }),
};

/** Оценка качества вопроса и ответ на вопрос (этап 1) */
export const stage1QuestionAPI = {
  evaluate: async ({ question_text, attribute_id, attribute_title, reference_insights }) =>
    safeFetch(`${base()}/question/evaluate`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        question_text,
        attribute_id,
        attribute_title,
        reference_insights: reference_insights ?? null,
      }),
    }),

  answer: async ({ question_text, attribute_id, attribute_title, reference_insights, documents_context, case_context, case_id, chat_history, current_patience, off_topic_count, stage1_requested_documents }) =>
    safeFetch(`${base()}/question/answer`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        question_text,
        attribute_id: attribute_id ?? null,
        attribute_title: attribute_title ?? null,
        reference_insights: reference_insights ?? null,
        documents_context: documents_context ?? null,
        case_context: case_context ?? null,
        case_id: case_id ?? null,
        chat_history: chat_history ?? null,
        current_patience: current_patience ?? null,
        off_topic_count: off_topic_count ?? null,
        stage1_requested_documents: stage1_requested_documents ?? null,
      }),
    }),
};
