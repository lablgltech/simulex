import React, { useState, useEffect, useCallback } from 'react';
import { getAdminApiUrl, getAdminHeaders, getApiUrl, getAuthHeaders } from '../api/config';
import { handleApiError } from '../api/errorHandler';
import { useAuth } from '../context/AuthContext';
import StageSelector from '../components/StageSelector';
import AdminFileModal from '../components/AdminFileModal';
import CaseEditorClassic from '../components/caseEditor/CaseEditorClassic';
import CaseEditorShell from '../components/caseEditor/CaseEditorShell';
import MarkdownContent from '../components/MarkdownContent';
import ReportView from '../components/ReportView';
import ManagerDashboard from '../components/dashboard/ManagerDashboard';
/** groupAdminHidden: скрыто у роли admin (руководитель группы); суперюзер видит всё. Симулятор у admin по-прежнему в пункте «Симулятор» в шапке приложения. */
const TABS = [
  { id: 'dashboard', label: 'Дашборд' },
  { id: 'cases', label: 'Кейсы', groupAdminHidden: true },
  { id: 'generate', label: 'Генерация кейса', groupAdminHidden: true },
  { id: 'users', label: 'Пользователи' },
  { id: 'reports', label: 'Отчёты' },
  { id: 'ai', label: 'ИИ-модели', groupAdminHidden: true },
  { id: 'ai_autoplay', label: 'ИИ-прогон', superuserOnly: true },
  { id: 'contract_consistency', label: 'Договор 2↔3', superuserOnly: true },
];

function validateCase(caseData) {
  const errors = [];
  if (!caseData?.title?.trim()) errors.push('Название кейса обязательно');
  if (!caseData?.stages?.length) errors.push('Кейс должен содержать хотя бы один этап');
  caseData.stages?.forEach((stage, idx) => {
    if (!stage.title?.trim()) errors.push(`Этап ${idx + 1}: название обязательно`);
    if (!Array.isArray(stage.actions) || stage.actions.length === 0) errors.push(`Этап ${idx + 1}: должно быть хотя бы одно действие`);
    stage.actions.forEach((action, aidx) => {
      if (!action.id) errors.push(`Этап ${idx + 1}, действие ${aidx + 1}: ID обязателен`);
      if (!action.title) errors.push(`Этап ${idx + 1}, действие ${aidx + 1}: название обязательно`);
      if (!action.costs) errors.push(`Этап ${idx + 1}, действие ${aidx + 1}: должны быть costs`);
      if (!action.lexic_impact) errors.push(`Этап ${idx + 1}, действие ${aidx + 1}: должно быть lexic_impact`);
    });
  });
  if (caseData.intro === undefined || caseData.intro === null) errors.push('Интро кейса обязательно (можно пустую строку)');
  if (caseData.outro === undefined || caseData.outro === null) errors.push('Аутро обязательно (можно пустую строку)');
  return errors;
}

export default function AdminView({ onLogout }) {
  const { user: currentUser, isSuperuser } = useAuth();
  const isGroupAdmin = currentUser?.role === 'admin';
  const [tab, setTab] = useState(() => (currentUser?.role === 'admin' ? 'dashboard' : 'cases'));

  useEffect(() => {
    if (!isGroupAdmin) return;
    const hit = TABS.find((x) => x.id === tab);
    if (!hit || hit.groupAdminHidden || (hit.superuserOnly && !isSuperuser)) {
      setTab('dashboard');
    }
  }, [isGroupAdmin, isSuperuser, tab]);
  const [cases, setCases] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingCase, setLoadingCase] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'ok' | 'error'
  const [reseedCasesStatus, setReseedCasesStatus] = useState(null); // null | 'loading' | 'ok' | 'error'
  const [validationErrors, setValidationErrors] = useState([]);
  const [jsonEditor, setJsonEditor] = useState('');
  const [view, setView] = useState('form'); // 'form' | 'json-editor'
  const [showStageSelector, setShowStageSelector] = useState(false);
  const [editingCase, setEditingCase] = useState(null);
  const [newCaseStages, setNewCaseStages] = useState([]);
  const [expandedStages, setExpandedStages] = useState({});
  const [fileModal, setFileModal] = useState(null); // { path, caseId? } — caseId для файлов в папке другого кейса
  /** Редактор кейса: классический или студия (карта зависимостей) */
  const [caseEditorMode, setCaseEditorMode] = useState('classic'); // 'classic' | 'studio'
  const [caseDependencyRefreshKey, setCaseDependencyRefreshKey] = useState(0);
  const [caseDirty, setCaseDirty] = useState(false);
  /** Превью documentation.md на вкладке «Кейсы» */
  const [methodologyDoc, setMethodologyDoc] = useState({ status: 'idle', text: '', error: null }); // idle | loading | ok | empty | error
  const [methodologyBump, setMethodologyBump] = useState(0);
  // Генерация кейса: мастер (материалы → анкета → результат)
  const [genTemplateId, setGenTemplateId] = useState('');
  const [genCreatorIntent, setGenCreatorIntent] = useState('');
  const [genContractFile, setGenContractFile] = useState(null);
  const [genGuideFile, setGenGuideFile] = useState(null);
  const [genContractText, setGenContractText] = useState('');
  const [genGuideText, setGenGuideText] = useState('');
  const [genWizardStep, setGenWizardStep] = useState('materials'); // materials | questionnaire | result
  const [genSessionId, setGenSessionId] = useState(null);
  const [genQuestions, setGenQuestions] = useState([]);
  const [genQuestionnaireComplete, setGenQuestionnaireComplete] = useState(false);
  const [genRound, setGenRound] = useState(0);
  const [genAnswerForm, setGenAnswerForm] = useState({});
  const [genIngestWarnings, setGenIngestWarnings] = useState([]);
  const [genStuck, setGenStuck] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  /** Локальная проверка мастера (материалы), не ответ API */
  const [genError, setGenError] = useState(null);
  /** Ошибка HTTP / сеть при вызове case-gen */
  const [genHttpError, setGenHttpError] = useState(null);
  /** Предупреждения из успешного JSON ответа анкеты */
  const [genApiWarnings, setGenApiWarnings] = useState([]);
  const [genQuestionnaireDebug, setGenQuestionnaireDebug] = useState(null);
  const [genParseStage, setGenParseStage] = useState(null);
  const [genResult, setGenResult] = useState(null);
  const [genDraftView, setGenDraftView] = useState('tree');
  const [genDraftJson, setGenDraftJson] = useState('');
  // Дашборд методиста
  const [dashboard, setDashboard] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  // Пользователи (вкладка)
  const [usersList, setUsersList] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userForm, setUserForm] = useState({
    username: '',
    password: '',
    role: 'user',
    email: '',
    group_id: '',
  });
  const [groupsList, setGroupsList] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupCreateError, setGroupCreateError] = useState('');
  const [userCreateStatus, setUserCreateStatus] = useState(null);
  const [userCreateError, setUserCreateError] = useState('');
  // Отчёты пользователей (разбивка по user)
  const [reportsByUser, setReportsByUser] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportModal, setReportModal] = useState(null); // { sessionId, username, report, caseData } or null
  const [reportModalLoading, setReportModalLoading] = useState(false);
  const [reportModalError, setReportModalError] = useState(null);
  // Настройки моделей ИИ (OpenAI/OpenRouter)
  const [aiConfig, setAiConfig] = useState({
    stage1_model: '',
    stage3_model: '',
    tutor_model: '',
    report_model: '',
  });
  const [aiAvailableModels, setAiAvailableModels] = useState([]);
  const [aiPopularModels, setAiPopularModels] = useState([]);
  const [aiConfigLoading, setAiConfigLoading] = useState(false);
  const [aiConfigSaving, setAiConfigSaving] = useState(false);
  const [aiConfigError, setAiConfigError] = useState(null);
  const [aiConfigSaved, setAiConfigSaved] = useState(false);
  // ИИ-автопрохождение (superuser)
  const [autoplayCases, setAutoplayCases] = useState([]);
  const [autoplayCaseId, setAutoplayCaseId] = useState('');
  const [autoplayUserId, setAutoplayUserId] = useState('');
  const [autoplayStyle, setAutoplayStyle] = useState('master');
  const [autoplayLoading, setAutoplayLoading] = useState(false);
  const [autoplayError, setAutoplayError] = useState('');
  const [autoplayResult, setAutoplayResult] = useState(null);
  /** Сверка stage-2/contract.json и stage-3/Contract_PO.md (superuser) */
  const [contractCheckCases, setContractCheckCases] = useState([]);
  const [contractCheckCaseId, setContractCheckCaseId] = useState('');
  const [contractCheckLoading, setContractCheckLoading] = useState(false);
  const [contractCheckError, setContractCheckError] = useState('');
  const [contractCheckResult, setContractCheckResult] = useState(null);

  const loadCases = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch(`${getAdminApiUrl()}/cases`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) throw new Error(res.statusText);
      const list = await res.json();
      setCases(Array.isArray(list) ? list : []);
    } catch (err) {
      handleApiError(err, false);
      setCases([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'cases') loadCases();
  }, [tab, loadCases]);

  useEffect(() => {
    if (tab === 'generate') loadCases();
  }, [tab, loadCases]);



  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const res = await fetch(`${getAdminApiUrl()}/dashboard`, {
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDashboard(data);
    } catch (err) {
      handleApiError(err, false);
      setDashboard(null);
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'dashboard') {
      loadDashboard();
    }
  }, [tab, loadDashboard]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const res = await fetch(`${getAdminApiUrl()}/users`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) throw new Error(await res.text());
      const list = await res.json();
      setUsersList(Array.isArray(list) ? list : []);
    } catch (err) {
      handleApiError(err, false);
      setUsersList([]);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    if (!isSuperuser) return;
    try {
      const res = await fetch(`${getAdminApiUrl()}/groups`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) throw new Error(await res.text());
      const list = await res.json();
      setGroupsList(Array.isArray(list) ? list : []);
    } catch (err) {
      handleApiError(err, false);
      setGroupsList([]);
    }
  }, [isSuperuser]);

  useEffect(() => {
    if (tab === 'users') {
      loadUsers();
      if (isSuperuser) loadGroups();
    }
  }, [tab, loadUsers, loadGroups, isSuperuser]);

  const loadAutoplayCases = useCallback(async () => {
    try {
      const res = await fetch(`${getAdminApiUrl()}/cases`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) throw new Error(res.statusText);
      const list = await res.json();
      const arr = Array.isArray(list) ? list : [];
      setAutoplayCases(arr);
      setAutoplayCaseId((prev) => prev || (arr[0]?.id || ''));
    } catch (err) {
      handleApiError(err, false);
      setAutoplayCases([]);
    }
  }, []);

  const handleAutoplayRun = useCallback(async () => {
    const uid = parseInt(String(autoplayUserId), 10);
    if (!autoplayCaseId || !uid) {
      setAutoplayError('Выберите кейс и пользователя (user).');
      return;
    }
    setAutoplayLoading(true);
    setAutoplayError('');
    setAutoplayResult(null);
    const POLL_MS = 2500;
    const MAX_POLLS = 500;
    try {
      const res = await fetch(`${getAdminApiUrl()}/autoplay/run`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify({
          case_id: autoplayCaseId,
          user_id: uid,
          play_style: autoplayStyle,
        }),
      });
      const startData = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint =
          res.status === 504
            ? 'Таймаут шлюза (504): повторите позже.'
            : '';
        throw new Error(
          [startData.detail || startData.message, hint].filter(Boolean).join(' ')
            || `${res.status} ${res.statusText || 'ошибка'}`.trim(),
        );
      }
      const jobId = startData.job_id;
      if (!jobId) {
        throw new Error('Сервер не вернул job_id');
      }
      for (let i = 0; i < MAX_POLLS; i += 1) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const sres = await fetch(`${getAdminApiUrl()}/autoplay/status/${encodeURIComponent(jobId)}`, {
          credentials: 'include',
          headers: getAdminHeaders(),
        });
        const st = await sres.json().catch(() => ({}));
        if (!sres.ok) {
          throw new Error(
            st.detail || st.message || `${sres.status} ${sres.statusText || 'ошибка опроса статуса'}`.trim(),
          );
        }
        if (st.status === 'done' && st.result) {
          setAutoplayResult(st.result);
          return;
        }
        if (st.status === 'error') {
          throw new Error(st.error || 'Ошибка прогона на сервере');
        }
      }
      throw new Error(
        'Превышено время ожидания опроса (~20 мин). Прогон может ещё выполняться на сервере — смотрите логи бэкенда.',
      );
    } catch (err) {
      setAutoplayError(err.message || 'Ошибка');
    } finally {
      setAutoplayLoading(false);
    }
  }, [autoplayCaseId, autoplayUserId, autoplayStyle]);

  useEffect(() => {
    if (tab === 'ai_autoplay' && isSuperuser) {
      loadAutoplayCases();
      loadUsers();
    }
  }, [tab, isSuperuser, loadAutoplayCases, loadUsers]);

  const loadContractCheckCases = useCallback(async () => {
    try {
      const res = await fetch(`${getAdminApiUrl()}/cases`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) throw new Error(res.statusText);
      const list = await res.json();
      const arr = Array.isArray(list) ? list : [];
      setContractCheckCases(arr);
      setContractCheckCaseId((prev) => prev || (arr[0]?.id || ''));
    } catch (err) {
      handleApiError(err, false);
      setContractCheckCases([]);
    }
  }, []);

  const handleContractConsistencyRun = useCallback(async () => {
    if (!contractCheckCaseId) {
      setContractCheckError('Выберите кейс.');
      return;
    }
    setContractCheckLoading(true);
    setContractCheckError('');
    setContractCheckResult(null);
    try {
      const q = new URLSearchParams({ case_id: contractCheckCaseId });
      const res = await fetch(`${getAdminApiUrl()}/contract-consistency?${q}`, {
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || data.error || res.statusText);
      }
      setContractCheckResult(data);
    } catch (err) {
      setContractCheckError(err.message || 'Ошибка');
    } finally {
      setContractCheckLoading(false);
    }
  }, [contractCheckCaseId]);

  useEffect(() => {
    if (tab === 'contract_consistency' && isSuperuser) {
      loadContractCheckCases();
    }
  }, [tab, isSuperuser, loadContractCheckCases]);

  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const res = await fetch(`${getAdminApiUrl()}/reports`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setReportsByUser(Array.isArray(data?.by_user) ? data.by_user : []);
    } catch (err) {
      handleApiError(err, false);
      setReportsByUser([]);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'reports') loadReports();
  }, [tab, loadReports]);

  const openReportModal = useCallback(async (sessionId, username) => {
    setReportModal(null);
    setReportModalError(null);
    setReportModalLoading(true);
    try {
      const sessionRes = await fetch(`${getAdminApiUrl()}/session/${sessionId}`, {
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      if (!sessionRes.ok) throw new Error('Сессия не найдена');
      const payload = await sessionRes.json();
      const reportRes = await fetch(`${getApiUrl()}/report/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify({ session: payload }),
      });
      if (!reportRes.ok) {
        const text = await reportRes.text();
        throw new Error(text || 'Не удалось сформировать отчёт');
      }
      const report = await reportRes.json();
      setReportModal({
        sessionId,
        username,
        report,
        caseData: {
          case: {
            title: report.case_title || 'Кейс',
            stages: (report.stages_info || []).map((s) => ({ id: s.stage_id, title: s.stage_title })),
          },
        },
      });
    } catch (err) {
      setReportModalError(err?.message || 'Ошибка загрузки отчёта');
      handleApiError(err, false);
    } finally {
      setReportModalLoading(false);
    }
  }, []);

  const loadAiConfig = useCallback(async () => {
    setAiConfigLoading(true);
    setAiConfigError(null);
    try {
      const res = await fetch(`${getAdminApiUrl()}/ai-config`, {
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setAiConfig({
        stage1_model: data.stage1_model || '',
        stage3_model: data.stage3_model || '',
        tutor_model: data.tutor_model || '',
        report_model: data.report_model || '',
      });
      setAiAvailableModels(Array.isArray(data.available_models) ? data.available_models : []);
      setAiPopularModels(Array.isArray(data.popular_models) ? data.popular_models : []);
    } catch (err) {
      setAiConfigError(err.message || 'Не удалось загрузить конфигурацию ИИ');
      handleApiError(err, false);
    } finally {
      setAiConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'ai') {
      loadAiConfig();
    }
  }, [tab, loadAiConfig]);

  const saveAiConfig = useCallback(async () => {
    setAiConfigSaving(true);
    setAiConfigError(null);
    setAiConfigSaved(false);
    try {
      const res = await fetch(`${getAdminApiUrl()}/ai-config`, {
        method: 'PUT',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify({
          stage1_model: aiConfig.stage1_model || undefined,
          stage3_model: aiConfig.stage3_model || undefined,
          tutor_model: aiConfig.tutor_model || undefined,
          report_model: aiConfig.report_model || undefined,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try {
          const j = JSON.parse(text);
          if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
        } catch (_) {}
        setAiConfigError(msg || `Ошибка ${res.status}`);
        throw new Error(msg);
      }
      const data = text ? JSON.parse(text) : {};
      setAiConfig({
        stage1_model: data.stage1_model || aiConfig.stage1_model,
        stage3_model: data.stage3_model || aiConfig.stage3_model,
        tutor_model: data.tutor_model || aiConfig.tutor_model,
        report_model: data.report_model || aiConfig.report_model,
      });
      setAiAvailableModels(Array.isArray(data.available_models) ? data.available_models : aiAvailableModels);
      setAiPopularModels(Array.isArray(data.popular_models) ? data.popular_models : aiPopularModels);
      setAiConfigSaved(true);
      setTimeout(() => setAiConfigSaved(false), 3000);
    } catch (err) {
      handleApiError(err, false);
    } finally {
      setAiConfigSaving(false);
    }
  }, [aiConfig, aiAvailableModels, aiPopularModels]);

  const handleCreateGroup = useCallback(async () => {
    const name = newGroupName.trim();
    if (!name) {
      setGroupCreateError('Введите название группы');
      return;
    }
    setGroupCreateError('');
    try {
      const res = await fetch(`${getAdminApiUrl()}/groups`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      setNewGroupName('');
      loadGroups();
    } catch (err) {
      setGroupCreateError(err.message || 'Ошибка');
    }
  }, [newGroupName, loadGroups]);

  const handleCreateUser = useCallback(async () => {
    if (!userForm.username.trim() || !userForm.password) {
      setUserCreateError('Логин и пароль обязательны');
      return;
    }
    const roleForRequest = isSuperuser ? userForm.role : userForm.role;
    if (isSuperuser && userForm.role !== 'superuser') {
      const gid = parseInt(String(userForm.group_id), 10);
      if (!gid) {
        setUserCreateError('Выберите группу для ролей admin и user');
        return;
      }
    }
    setUserCreateStatus('loading');
    setUserCreateError('');
    try {
      const payload = {
        username: userForm.username.trim(),
        password: userForm.password,
        role: roleForRequest,
        email: userForm.email.trim() || undefined,
      };
      if (isSuperuser && userForm.role !== 'superuser') {
        payload.group_id = parseInt(String(userForm.group_id), 10);
      }
      const res = await fetch(`${getAdminApiUrl()}/users`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      setUserCreateStatus('ok');
      setUserForm({ username: '', password: '', role: 'user', email: '', group_id: '' });
      loadUsers();
      setTimeout(() => setUserCreateStatus(null), 3000);
    } catch (err) {
      setUserCreateError(err.message || 'Ошибка');
      setUserCreateStatus('error');
      setTimeout(() => setUserCreateStatus(null), 4000);
    }
  }, [userForm, isSuperuser, loadUsers]);

  const handleDeleteUser = useCallback(async (userId) => {
    if (!window.confirm('Удалить этого пользователя?')) return;
    try {
      const res = await fetch(`${getAdminApiUrl()}/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      if (!res.ok) throw new Error(await res.text());
      loadUsers();
    } catch (err) {
      handleApiError(err, false);
    }
  }, [loadUsers]);

  useEffect(() => {
    if (!genQuestions?.length) return;
    setGenAnswerForm((prev) => {
      const next = { ...prev };
      genQuestions.forEach((q) => {
        if (!next[q.id]) next[q.id] = { selected: [], details: '' };
      });
      return next;
    });
  }, [genQuestions]);

  const resetCaseGenWizard = useCallback(() => {
    setGenWizardStep('materials');
    setGenSessionId(null);
    setGenQuestions([]);
    setGenQuestionnaireComplete(false);
    setGenRound(0);
    setGenAnswerForm({});
    setGenIngestWarnings([]);
    setGenStuck(false);
    setGenResult(null);
    setGenError(null);
    setGenHttpError(null);
    setGenApiWarnings([]);
    setGenQuestionnaireDebug(null);
    setGenParseStage(null);
    setGenDraftJson('');
  }, []);

  const startCaseGenSession = useCallback(async () => {
    if (!genTemplateId || !genCreatorIntent.trim()) return;
    const hasContract = genContractFile || genContractText.trim();
    const hasGuide = genGuideFile || genGuideText.trim();
    if (!hasContract || !hasGuide) {
      setGenError('Нужны договор и гайд компании (политика по договорам): файл или текст для каждого.');
      return;
    }
    setGenLoading(true);
    setGenError(null);
    setGenHttpError(null);
    setGenApiWarnings([]);
    setGenQuestionnaireDebug(null);
    setGenParseStage(null);
    setGenStuck(false);
    setGenResult(null);
    try {
      const fd = new FormData();
      fd.append('template_case_id', genTemplateId);
      fd.append('creator_intent', genCreatorIntent.trim());
      if (genContractFile) fd.append('contract_file', genContractFile);
      else fd.append('contract_template', genContractText);
      if (genGuideFile) fd.append('guide_file', genGuideFile);
      else fd.append('guide', genGuideText);
      const headers = { ...getAdminHeaders() };
      delete headers['Content-Type'];
      const res = await fetch(`${getAdminApiUrl()}/case-gen/start`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: fd,
      });
      if (!res.ok) {
        const errBody = await res.text();
        setGenHttpError(errBody || `Ошибка ${res.status}`);
        handleApiError(new Error(errBody || res.status), false);
        return;
      }
      const data = await res.json();
      setGenSessionId(data.session_id);
      setGenIngestWarnings(data.ingest_warnings || []);
      setGenQuestions(data.questions || []);
      setGenQuestionnaireComplete(!!data.questionnaire_complete);
      setGenRound(data.round ?? 0);
      setGenWizardStep(data.questionnaire_complete ? 'result' : 'questionnaire');
      if (data.stuck) setGenStuck(true);
      setGenApiWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setGenQuestionnaireDebug(data.questionnaire_debug ?? null);
      setGenParseStage(data.questionnaire_parse_stage ?? null);
    } catch (err) {
      setGenHttpError(err.message || 'Ошибка старта сессии');
      handleApiError(err, false);
    } finally {
      setGenLoading(false);
    }
  }, [genTemplateId, genCreatorIntent, genContractFile, genGuideFile, genContractText, genGuideText]);

  const submitCaseGenAnswers = useCallback(async () => {
    if (!genSessionId) return;
    const answers = {};
    genQuestions.forEach((q) => {
      const row = genAnswerForm[q.id] || { selected: [], details: '' };
      answers[q.id] = {
        selected: Array.isArray(row.selected) ? row.selected : [],
        details: typeof row.details === 'string' ? row.details : '',
      };
    });
    setGenLoading(true);
    setGenHttpError(null);
    setGenApiWarnings([]);
    setGenQuestionnaireDebug(null);
    setGenParseStage(null);
    try {
      const res = await fetch(`${getAdminApiUrl()}/case-gen/${encodeURIComponent(genSessionId)}/answer`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        setGenHttpError(errBody || `Ошибка ${res.status}`);
        handleApiError(new Error(errBody || res.status), false);
        return;
      }
      const data = await res.json();
      setGenQuestions(data.questions || []);
      setGenQuestionnaireComplete(!!data.questionnaire_complete);
      setGenRound(data.round ?? 0);
      if (data.stuck) setGenStuck(true);
      setGenApiWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setGenQuestionnaireDebug(data.questionnaire_debug ?? null);
      setGenParseStage(data.questionnaire_parse_stage ?? null);
      if (data.questionnaire_complete) {
        setGenWizardStep('result');
      }
    } catch (err) {
      setGenHttpError(err.message || 'Ошибка отправки ответов');
      handleApiError(err, false);
    } finally {
      setGenLoading(false);
    }
  }, [genSessionId, genQuestions, genAnswerForm]);

  const runCaseGenGeneration = useCallback(async () => {
    if (!genSessionId) return;
    setGenLoading(true);
    setGenHttpError(null);
    try {
      const res = await fetch(`${getAdminApiUrl()}/case-gen/${encodeURIComponent(genSessionId)}/run-generation`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
      });
      if (!res.ok) {
        const errBody = await res.text();
        setGenHttpError(errBody || `Ошибка ${res.status}`);
        handleApiError(new Error(errBody || res.status), false);
        return;
      }
      const data = await res.json();
      setGenResult(data);
      setGenDraftJson(JSON.stringify(data.draft || {}, null, 2));
      setGenDraftView('tree');
      setGenWizardStep('result');
    } catch (err) {
      setGenHttpError(err.message || 'Ошибка генерации');
      handleApiError(err, false);
    } finally {
      setGenLoading(false);
    }
  }, [genSessionId]);

  const loadFullCase = useCallback(async (id) => {
    if (!id) return;
    setLoadingCase(true);
    setValidationErrors([]);
    try {
      const res = await fetch(`${getAdminApiUrl()}/cases/${encodeURIComponent(id)}`, { credentials: 'include', headers: getAdminHeaders() });
      if (!res.ok) {
        if (res.status === 404) setSelectedCase(null);
        else throw new Error(await res.text());
        return;
      }
      const data = await res.json();
      setSelectedCase(data);
      setCaseDirty(false);
      setView('form');
    } catch (err) {
      handleApiError(err, false);
      setSelectedCase(null);
    } finally {
      setLoadingCase(false);
    }
  }, []);

  const saveGeneratedAsCase = useCallback(async () => {
    const draft = genResult?.draft;
    if (!draft) return;
    let toSave = draft;
    if (genDraftView === 'json') {
      try {
        toSave = JSON.parse(genDraftJson);
      } catch (e) {
        handleApiError(new Error('Невалидный JSON в редакторе'), false);
        return;
      }
    }
    try {
      const payload = genTemplateId ? { ...toSave, resource_template_case_id: genTemplateId } : toSave;
      const res = await fetch(`${getAdminApiUrl()}/cases`, {
        method: 'POST',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      const { case: created } = await res.json();
      loadCases();
      setSelectedCase(created);
      setTab('cases');
      loadFullCase(created.id);
      setGenResult(null);
    } catch (err) {
      handleApiError(err, false);
    }
  }, [genResult, genDraftView, genDraftJson, loadCases, loadFullCase, genTemplateId]);

  const downloadDraftJson = useCallback(() => {
    const draft = genResult?.draft;
    if (!draft) return;
    const str = genDraftView === 'json' ? genDraftJson : JSON.stringify(draft, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `case-draft-${draft.id || 'draft'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [genResult, genDraftView, genDraftJson]);

  const handleSelectCase = (caseItem) => {
    if (caseItem?.id === selectedCase?.id) return;
    if (caseDirty) {
      if (!window.confirm('Несохранённые изменения кейса будут потеряны. Переключить кейс?')) return;
    }
    setSelectedCase(null);
    loadFullCase(caseItem?.id);
  };

  const handleSaveCase = async () => {
    if (!selectedCase?.id) return;
    const errors = validateCase(selectedCase);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors([]);
    setSaveStatus('saving');
    try {
      const res = await fetch(`${getAdminApiUrl()}/cases/${encodeURIComponent(selectedCase.id)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: getAdminHeaders(),
        body: JSON.stringify(selectedCase),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveStatus('ok');
      setCaseDirty(false);
      loadCases();
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus('error');
      handleApiError(err, false);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  const handleNewCase = () => {
    setShowStageSelector(true);
    setEditingCase(null);
    setNewCaseStages([]);
  };

  const handleStageSelectorConfirm = async (stages, configs) => {
    if (editingCase) {
      const updated = { ...editingCase, stages };
      setSelectedCase(updated);
      setCaseDirty(true);
      setCases((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated, stages_count: stages.length } : c)));
    } else {
      try {
        const res = await fetch(`${getAdminApiUrl()}/cases`, {
          method: 'POST',
          credentials: 'include',
          headers: getAdminHeaders(),
          body: JSON.stringify({ title: 'Новый кейс', description: '', stages }),
        });
        if (!res.ok) throw new Error(await res.text());
        const { case: created } = await res.json();
        setSelectedCase(created);
        loadCases();
      } catch (err) {
        handleApiError(err, false);
      }
    }
    setShowStageSelector(false);
    setEditingCase(null);
    setNewCaseStages([]);
  };

  const toggleStage = (stageId) => {
    setExpandedStages((prev) => ({ ...prev, [stageId]: !prev[stageId] }));
  };

  const openFileModal = (path, fileCaseId) => setFileModal({ path, caseId: fileCaseId || undefined });
  const closeFileModal = () => setFileModal(null);

  useEffect(() => {
    if (!selectedCase?.id) {
      setMethodologyDoc({ status: 'idle', text: '', error: null });
      return;
    }
    let cancelled = false;
    setMethodologyDoc((prev) => ({ ...prev, status: 'loading', error: null }));
    const url = `${getAdminApiUrl()}/cases/${encodeURIComponent(selectedCase.id)}/file?path=${encodeURIComponent('documentation.md')}`;
    fetch(url, { credentials: 'include', headers: getAdminHeaders() })
      .then(async (res) => {
        if (res.status === 404) return { _empty: true };
        if (!res.ok) throw new Error(`Ошибка ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (data?._empty) {
          setMethodologyDoc({ status: 'empty', text: '', error: null });
          return;
        }
        const text = typeof data?.content === 'string' ? data.content : '';
        setMethodologyDoc({ status: 'ok', text, error: null });
      })
      .catch((err) => {
        if (!cancelled) setMethodologyDoc({ status: 'error', text: '', error: err.message || 'Ошибка загрузки' });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCase?.id, methodologyBump]);

  useEffect(() => {
    setCaseEditorMode('classic');
  }, [selectedCase?.id]);

  const updateCase = (patch) => {
    setCaseDirty(true);
    setSelectedCase((c) => (c ? { ...c, ...patch } : null));
  };
  const updateStage = (stageIndex, patch) => {
    setCaseDirty(true);
    setSelectedCase((c) => {
      if (!c?.stages) return c;
      const stages = [...c.stages];
      stages[stageIndex] = { ...stages[stageIndex], ...patch };
      return { ...c, stages };
    });
  };

  // ——— JSON editor view ———
  if (view === 'json-editor') {
    return (
      <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
        <h1>Редактор JSON кейса</h1>
        {validationErrors.length > 0 && (
          <ul style={{ color: '#c00', marginBottom: '12px' }}>
            {validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        <textarea
          value={jsonEditor}
          onChange={(e) => setJsonEditor(e.target.value)}
          style={{ width: '100%', height: '500px', fontFamily: 'monospace', padding: '10px', fontSize: '12px', border: '1px solid #ccc', borderRadius: '4px', marginBottom: '16px' }}
        />
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => {
              try {
                const parsed = JSON.parse(jsonEditor);
                const errs = validateCase(parsed);
                if (errs.length > 0) {
                  setValidationErrors(errs);
                  return;
                }
                setSelectedCase(parsed);
                setCaseDirty(true);
                setValidationErrors([]);
                setView('form');
              } catch (e) {
                setValidationErrors(['Ошибка парсинга JSON: ' + e.message]);
              }
            }}
            style={{ padding: '10px 20px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Применить и вернуться
          </button>
          <button onClick={() => setView('form')} style={{ padding: '10px 20px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            Отмена
          </button>
        </div>
      </div>
    );
  }

  // ——— Main layout ———
  return (
    <div style={{ padding: '20px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ margin: 0 }}>Панель администратора</h1>
        <button onClick={onLogout} style={{ padding: '8px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          Выход
        </button>
      </div>


      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '1px solid #e5e7eb' }}>
        {TABS.filter((t) => {
          if (t.superuserOnly && !isSuperuser) return false;
          if (t.groupAdminHidden && isGroupAdmin) return false;
          return true;
        }).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 16px',
              background: tab === t.id ? '#3b82f6' : 'transparent',
              color: tab === t.id ? 'white' : '#374151',
              border: 'none',
              borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
              cursor: 'pointer',
              fontWeight: tab === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Новый дашборд руководителя с нормализованным LEXIC */}
          <div style={{ marginBottom: '8px' }}>
            <h2 style={{ margin: 0 }}>Дашборд руководителя</h2>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#6b7280' }}>
              Интерактивный мониторинг симуляций с нормализованными оценками LEXIC.
            </p>
          </div>
          <div style={{ background: 'white', borderRadius: '12px', border: '1px solid #e5e7eb', marginBottom: '16px' }}>
            <ManagerDashboard
              apiBase=""
              token={typeof localStorage !== 'undefined' ? localStorage.getItem('simulex_auth_token') || '' : ''}
            />
          </div>

          {isSuperuser && (
          <>
          {/* Существующий дашборд (статистика) — только для superuser */}
          <div style={{ marginBottom: '4px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', color: '#374151' }}>📈 Статистика сессий (классическая)</h3>
          </div>

          {dashboardLoading && <p style={{ color: '#6b7280' }}>Загрузка дашборда…</p>}

          {!dashboardLoading && dashboard && (
            <>
              {/* 1. Общие числа */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Всего сессий</div>
                  <div style={{ fontSize: '22px', fontWeight: 700 }}>{dashboard.overall?.total_sessions ?? 0}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                    За 30 дней: {dashboard.overall?.sessions_last_30d ?? 0} · за 7 дней: {dashboard.overall?.sessions_last_7d ?? 0}
                  </div>
                </div>
                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Сессий с отчётом / summary</div>
                  <div style={{ fontSize: '22px', fontWeight: 700 }}>{dashboard.overall?.sessions_with_summary ?? 0}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                    Доля: {Math.round((dashboard.overall?.completion_rate ?? 0) * 100)}%
                  </div>
                </div>
                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>Кейсы</div>
                  <div style={{ fontSize: '22px', fontWeight: 700 }}>{dashboard.overall?.distinct_cases ?? 0}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>Количество разных кейсов в сессиях</div>
                </div>
              </div>

              {/* 2. LEXIC распределение и soft skills */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '16px', alignItems: 'stretch' }}>
                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Средние LEXIC по сессиям</h3>
                  <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>
                    На базе {dashboard.lexic?.total_sessions_with_lexic ?? 0} сессий.
                  </p>
                  {['L', 'E', 'X', 'I', 'C'].map((k) => {
                    const key = `avg_${k}`;
                    const value = dashboard.lexic?.[key] ?? null;
                    return (
                      <div key={k} style={{ marginBottom: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280' }}>
                          <span>{k}</span>
                          <span>{value != null ? Math.round(value) : '—'}</span>
                        </div>
                        <div style={{ height: '6px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${Math.max(0, Math.min(100, value || 0))}%`,
                              height: '100%',
                              background: '#3b82f6',
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Soft-skills профиль</h3>
                  <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>
                    Профилей: {dashboard.soft_skills?.total_profiles ?? 0}
                  </p>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px', color: '#374151' }}>
                    <li style={{ marginBottom: '4px' }}>
                      <strong>Аргументация:</strong>{' '}
                      {dashboard.soft_skills?.avg_argumentation_level != null
                        ? `${Math.round(dashboard.soft_skills.avg_argumentation_level * 100)}%`
                        : '—'}
                    </li>
                    <li style={{ marginBottom: '4px' }}>
                      <strong>Склонность к риску:</strong>{' '}
                      {dashboard.soft_skills?.avg_risk_aversion != null
                        ? `${Math.round(dashboard.soft_skills.avg_risk_aversion * 100)}% (1 = осторожный)`
                        : '—'}
                    </li>
                    <li style={{ marginBottom: '4px' }}>
                      <strong>Рефлексия:</strong>{' '}
                      {dashboard.soft_skills?.avg_self_reflection != null
                        ? `${Math.round(dashboard.soft_skills.avg_self_reflection * 100)}%`
                        : '—'}
                    </li>
                  </ul>
                  {dashboard.soft_skills?.negotiation_styles?.length > 0 && (
                    <div style={{ marginTop: '8px', fontSize: '12px', color: '#6b7280' }}>
                      <strong>Стили переговоров:</strong>
                      <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0 0' }}>
                        {dashboard.soft_skills.negotiation_styles.map((s) => (
                          <li key={s.style}>
                            {s.style}: {s.count}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* 3. Кейсы и этапы */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '16px' }}>
                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Кейсы: сессии и средний LEXIC</h3>
                  {dashboard.sessions_by_case?.length ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>Кейс</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>Сессий</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>Средний LEXIC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dashboard.sessions_by_case.map((c) => (
                          <tr key={c.case_code || 'unknown'}>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>
                              <code>{c.case_code || 'unknown'}</code>
                            </td>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>{c.total_sessions}</td>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>
                              {c.avg_lexic != null ? Math.round(c.avg_lexic) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p style={{ fontSize: '13px', color: '#9ca3af' }}>Пока нет данных по кейсам.</p>
                  )}
                </div>

                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Завершения этапов</h3>
                  {dashboard.stage_completion?.length ? (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px', color: '#374151' }}>
                      {dashboard.stage_completion.map((s) => (
                        <li key={s.stage_code} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                          <span>{s.stage_code}</span>
                          <span>{s.completions}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ fontSize: '13px', color: '#9ca3af' }}>Ещё нет завершений этапов.</p>
                  )}
                </div>
              </div>

              {/* 4. Тьютор и последние сессии */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '16px' }}>
                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Использование тьютора</h3>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px', color: '#374151' }}>
                    <li style={{ marginBottom: '4px' }}>
                      <strong>Сообщений всего:</strong> {dashboard.tutor_usage?.total_messages ?? 0}
                    </li>
                    <li style={{ marginBottom: '4px' }}>
                      <strong>Сессий с тьютором:</strong> {dashboard.tutor_usage?.sessions_with_tutor ?? 0}
                    </li>
                    <li>
                      <strong>Среднее сообщений на сессию:</strong>{' '}
                      {dashboard.tutor_usage
                        ? dashboard.tutor_usage.avg_messages_per_session.toFixed(1)
                        : '0.0'}
                    </li>
                  </ul>
                </div>

                <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Последние сессии</h3>
                  {dashboard.recent_sessions?.length ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>ID</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>Кейс</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>LEXIC</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>Summary</th>
                          <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #e5e7eb' }}>Старт</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dashboard.recent_sessions.map((s) => (
                          <tr key={s.session_id}>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6', maxWidth: '120px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                              {s.session_id}
                            </td>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>
                              <code>{s.case_code || 'unknown'}</code>
                            </td>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>
                              {s.avg_lexic != null ? Math.round(s.avg_lexic) : '—'}
                            </td>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>
                              {s.has_summary ? 'да' : 'нет'}
                            </td>
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #f3f4f6' }}>
                              {s.created_at ? new Date(s.created_at).toLocaleString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p style={{ fontSize: '13px', color: '#9ca3af' }}>Сессий пока нет.</p>
                  )}
                </div>
              </div>
            </>
          )}
          </>
          )}
        </div>
      )}

      {tab === 'ai' && (
        <div style={{ maxWidth: '800px' }}>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '20px' }}>
            <h2 style={{ margin: '0 0 8px 0' }}>Настройки моделей ИИ</h2>
            <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#6b7280' }}>
              Выберите модели ИИ для этапа 1 (инициатор), этапа 3 (ИИ-контрагент), тьютора и отчёта (нарратив, summary). По умолчанию для всех ролей — <code style={{ fontSize: '12px' }}>google/gemini-3-flash-preview</code> (OpenRouter), если в <code style={{ fontSize: '12px' }}>data/ai_model_config.json</code> не задано иное.
            </p>
            {aiConfigLoading && <p style={{ color: '#6b7280' }}>Загрузка настроек…</p>}
            {!aiConfigLoading && (
              <>
                {aiConfigError && (
                  <div style={{ marginBottom: '12px', color: '#b91c1c', fontSize: '13px' }}>
                    {aiConfigError}
                  </div>
                )}
                {aiPopularModels.length > 0 && (
                  <div style={{ marginBottom: '12px', fontSize: '13px', color: '#6b7280' }}>
                    Популярные модели:&nbsp;
                    {aiPopularModels.map((m) => (
                      <code key={m} style={{ marginRight: '6px' }}>{m}</code>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Этап 1 (инициатор)</label>
                    <select
                      value={aiConfig.stage1_model}
                      onChange={(e) => setAiConfig((c) => ({ ...c, stage1_model: e.target.value }))}
                      style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                    >
                      {!aiConfig.stage1_model && <option value="">По умолчанию (Gemini 3 Flash / конфиг)</option>}
                      {aiAvailableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Этап 3 (переговоры)</label>
                    <select
                      value={aiConfig.stage3_model}
                      onChange={(e) => setAiConfig((c) => ({ ...c, stage3_model: e.target.value }))}
                      style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                    >
                      {!aiConfig.stage3_model && <option value="">По умолчанию (Gemini 3 Flash / конфиг)</option>}
                      {aiAvailableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Тьютор</label>
                    <select
                      value={aiConfig.tutor_model}
                      onChange={(e) => setAiConfig((c) => ({ ...c, tutor_model: e.target.value }))}
                      style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                    >
                      {!aiConfig.tutor_model && <option value="">По умолчанию (Gemini 3 Flash / конфиг)</option>}
                      {aiAvailableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Отчёт (нарратив, summary)</label>
                    <select
                      value={aiConfig.report_model}
                      onChange={(e) => setAiConfig((c) => ({ ...c, report_model: e.target.value }))}
                      style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                    >
                      {!aiConfig.report_model && <option value="">По умолчанию (Gemini 3 Flash / конфиг)</option>}
                      {aiAvailableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={saveAiConfig}
                  disabled={aiConfigSaving}
                  style={{
                    padding: '8px 20px',
                    background: aiConfigSaving ? '#9ca3af' : '#10b981',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: aiConfigSaving ? 'not-allowed' : 'pointer',
                    fontWeight: 500,
                  }}
                >
                  {aiConfigSaving ? 'Сохранение…' : aiConfigSaved ? 'Сохранено' : 'Сохранить'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'generate' && (
        <div style={{ maxWidth: '920px' }}>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '20px' }}>
            <h3 style={{ margin: '0 0 8px 0' }}>Генерация кейса (мастер)</h3>
            <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
              Шаг 1: текст договора и внутренний гайд компании по работе с договорами (PDF, DOCX или MD — файл или текст) плюс запрос создателя. Шаг 2: анкета. Шаг 3: генерация и сохранение черновика.
              Анкета может использовать отдельную модель (<code style={{ fontSize: '12px' }}>CASE_QUESTIONNAIRE_MODEL</code>); по умолчанию та же, что и <code style={{ fontSize: '12px' }}>CASE_GENERATION_MODEL</code> (<code style={{ fontSize: '12px' }}>google/gemini-3-flash-preview</code>). Structured output вкл. по умолчанию; при сбоях —{' '}
              <code style={{ fontSize: '12px' }}>CASE_GEN_QUESTIONNAIRE_STRUCTURED_METHOD</code> и <code style={{ fontSize: '12px' }}>CASE_GEN_DIAGNOSTICS=1</code>.
            </p>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: genWizardStep === 'materials' ? '#7c3aed' : '#9ca3af' }}>1. Материалы</span>
              <span>→</span>
              <span style={{ fontWeight: 600, color: genWizardStep === 'questionnaire' ? '#7c3aed' : '#9ca3af' }}>2. Анкета</span>
              <span>→</span>
              <span style={{ fontWeight: 600, color: genWizardStep === 'result' ? '#7c3aed' : '#9ca3af' }}>3. Результат</span>
              <button type="button" onClick={resetCaseGenWizard} style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db', borderRadius: '4px', background: '#fff', cursor: 'pointer' }}>Сбросить</button>
            </div>

            {genWizardStep === 'materials' && (
              <>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Структурный шаблон кейса</label>
                  <select value={genTemplateId} onChange={(e) => setGenTemplateId(e.target.value)} style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}>
                    <option value="">— Выберите кейс —</option>
                    {cases.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Запрос создателя (что должен дать кейс)</label>
                  <textarea value={genCreatorIntent} onChange={(e) => setGenCreatorIntent(e.target.value)} rows={3} placeholder="Аудитория, акценты, сложность, цели обучения…" style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Шаблон договора</label>
                    <input type="file" accept=".pdf,.docx,.md,.markdown" onChange={(e) => setGenContractFile(e.target.files?.[0] || null)} style={{ marginBottom: '8px' }} />
                    <textarea value={genContractText} onChange={(e) => setGenContractText(e.target.value)} rows={6} placeholder="Или вставьте текст договора…" style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px' }}>Гайд компании (корпоративные установки по договорам)</label>
                    <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '6px' }}>Не инструкция участнику — политика/матрица согласований/красные флаги вашей организации.</div>
                    <input type="file" accept=".pdf,.docx,.md,.markdown" onChange={(e) => setGenGuideFile(e.target.files?.[0] || null)} style={{ marginBottom: '8px' }} />
                    <textarea value={genGuideText} onChange={(e) => setGenGuideText(e.target.value)} rows={6} placeholder="Или вставьте текст гайда компании…" style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px' }} />
                  </div>
                </div>
                {genError && <div style={{ color: '#dc2626', marginBottom: '12px', fontSize: '14px' }}>{genError}</div>}
                {genHttpError && (
                  <div style={{ color: '#dc2626', marginBottom: '12px', fontSize: '14px' }}>
                    <strong>Ошибка запроса:</strong> {genHttpError}
                  </div>
                )}
                {genApiWarnings.length > 0 && (
                  <ul style={{ color: '#b45309', marginBottom: '12px', fontSize: '14px' }}>
                    {genApiWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <button type="button" onClick={startCaseGenSession} disabled={!genTemplateId || !genCreatorIntent.trim() || genLoading} style={{ padding: '10px 20px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', opacity: genLoading ? 0.6 : 1 }}>
                  {genLoading ? 'Загрузка…' : 'Далее: начать анкету'}
                </button>
              </>
            )}

            {genWizardStep === 'questionnaire' && (
              <>
                {genIngestWarnings?.length > 0 && (
                  <ul style={{ color: '#b45309', fontSize: '13px', marginBottom: '12px' }}>
                    {genIngestWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <p style={{ fontSize: '13px', color: '#6b7280' }}>
                  Раунд: {genRound}
                  {genStuck && <strong style={{ color: '#dc2626', marginLeft: '8px' }}>Лимит раундов — начните заново</strong>}
                  {genParseStage && (
                    <span style={{ marginLeft: '8px', color: '#9ca3af' }}>(разбор: {genParseStage})</span>
                  )}
                </p>
                {genHttpError && (
                  <div style={{ color: '#dc2626', marginBottom: '10px', fontSize: '14px' }}>
                    <strong>Ошибка запроса:</strong> {genHttpError}
                  </div>
                )}
                {genApiWarnings.length > 0 && (
                  <ul style={{ color: '#b45309', marginBottom: '12px', fontSize: '14px' }}>
                    {genApiWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {genQuestionnaireDebug && (
                  <details style={{ marginBottom: '12px', fontSize: '12px', color: '#4b5563' }}>
                    <summary style={{ cursor: 'pointer' }}>Диагностика анкеты (сервер)</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px', background: '#f9fafb', padding: '8px', borderRadius: '4px' }}>
                      {JSON.stringify(genQuestionnaireDebug, null, 2)}
                    </pre>
                  </details>
                )}
                {genQuestionnaireComplete && (
                  <div style={{ marginBottom: '16px' }}>
                    <p style={{ color: '#059669', fontWeight: 600 }}>Анкета завершена.</p>
                    <button type="button" onClick={runCaseGenGeneration} disabled={genLoading} style={{ padding: '10px 20px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                      {genLoading ? 'Генерация…' : 'Запустить генерацию кейса'}
                    </button>
                  </div>
                )}
                {!genQuestionnaireComplete && genQuestions.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {genQuestions.map((q) => (
                      <div key={q.id} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px' }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px' }}>{q.prompt}</div>
                        {q.help && <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>{q.help}</div>}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                          {(q.options || []).map((opt) => (
                            <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', fontSize: '14px' }}>
                              {q.choice_mode === 'multi' ? (
                                <input
                                  type="checkbox"
                                  checked={(genAnswerForm[q.id]?.selected || []).includes(opt.value)}
                                  onChange={(e) => {
                                    const cur = genAnswerForm[q.id] || { selected: [], details: '' };
                                    const set = new Set(cur.selected || []);
                                    if (e.target.checked) set.add(opt.value);
                                    else set.delete(opt.value);
                                    setGenAnswerForm((prev) => ({
                                      ...prev,
                                      [q.id]: { ...cur, selected: [...set] },
                                    }));
                                  }}
                                />
                              ) : (
                                <input
                                  type="radio"
                                  name={`q_${q.id}`}
                                  checked={(genAnswerForm[q.id]?.selected || [])[0] === opt.value}
                                  onChange={() => {
                                    const cur = genAnswerForm[q.id] || { selected: [], details: '' };
                                    setGenAnswerForm((prev) => ({
                                      ...prev,
                                      [q.id]: { ...cur, selected: [opt.value] },
                                    }));
                                  }}
                                />
                              )}
                              <span>{opt.label}</span>
                            </label>
                          ))}
                        </div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{q.free_text_prompt || 'Уточнения'}</label>
                        <textarea
                          value={genAnswerForm[q.id]?.details || ''}
                          onChange={(e) => {
                            const cur = genAnswerForm[q.id] || { selected: [], details: '' };
                            setGenAnswerForm((prev) => ({
                              ...prev,
                              [q.id]: { ...cur, details: e.target.value },
                            }));
                          }}
                          rows={3}
                          style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px' }}
                        />
                      </div>
                    ))}
                    {genHttpError && (
                      <div style={{ color: '#dc2626', fontSize: '14px', marginBottom: '8px' }}>{genHttpError}</div>
                    )}
                    {genApiWarnings.length > 0 && (
                      <ul style={{ color: '#b45309', fontSize: '14px', marginBottom: '8px' }}>
                        {genApiWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                    <button type="button" onClick={submitCaseGenAnswers} disabled={genLoading || genStuck} style={{ padding: '10px 20px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                      {genLoading ? 'Отправка…' : 'Отправить ответы'}
                    </button>
                  </div>
                )}
                {!genQuestionnaireComplete && genQuestions.length === 0 && !genStuck && (
                  <div>
                    {genHttpError && (
                      <p style={{ color: '#b91c1c', marginBottom: '8px', fontSize: '14px' }}>{genHttpError}</p>
                    )}
                    {genApiWarnings.length > 0 && (
                      <ul style={{ color: '#b45309', marginBottom: '8px', fontSize: '14px' }}>
                        {genApiWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                    <p style={{ color: '#6b7280' }}>
                      Нет вопросов. Нажмите «Сбросить» и повторите попытку. При CASE_GEN_DIAGNOSTICS=1 на бэкенде в ответе появится блок диагностики ниже.
                    </p>
                  </div>
                )}
              </>
            )}

            {genWizardStep === 'result' && (
              <>
                {!genResult?.draft && genQuestionnaireComplete && (
                  <div style={{ marginBottom: '16px' }}>
                    <button type="button" onClick={runCaseGenGeneration} disabled={genLoading} style={{ padding: '10px 20px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                      {genLoading ? 'Генерация…' : 'Запустить генерацию кейса'}
                    </button>
                  </div>
                )}
                {genHttpError && (
                  <div style={{ color: '#dc2626', marginBottom: '12px', fontSize: '14px' }}>{genHttpError}</div>
                )}
                {genResult?.draft && (
                  <div style={{ background: '#fafafa', padding: '16px', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                      <h3 style={{ margin: 0 }}>Черновик</h3>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => setGenDraftView('tree')} style={{ padding: '6px 12px', background: genDraftView === 'tree' ? '#7c3aed' : '#e5e7eb', color: genDraftView === 'tree' ? 'white' : '#374151', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Дерево</button>
                        <button type="button" onClick={() => setGenDraftView('json')} style={{ padding: '6px 12px', background: genDraftView === 'json' ? '#7c3aed' : '#e5e7eb', color: genDraftView === 'json' ? 'white' : '#374151', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>JSON</button>
                        <button type="button" onClick={saveGeneratedAsCase} style={{ padding: '6px 12px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Сохранить как новый кейс</button>
                        <button type="button" onClick={downloadDraftJson} style={{ padding: '6px 12px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Скачать JSON</button>
                      </div>
                    </div>
                    {(genResult.warnings || []).length > 0 && (
                      <ul style={{ color: '#b45309', marginBottom: '12px', fontSize: '14px' }}>
                        {genResult.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                    {(genResult.validation_errors || []).length > 0 && (
                      <ul style={{ color: '#dc2626', marginBottom: '12px', fontSize: '13px' }}>
                        {genResult.validation_errors.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                    {genDraftView === 'tree' && (
                      <div style={{ fontSize: '14px' }}>
                        <p><strong>id:</strong> {genResult.draft.id} · <strong>title:</strong> {genResult.draft.title}</p>
                        <p><strong>Этапы:</strong> {(genResult.draft.stages || []).map((s) => `${s.id} (${s.type})`).join(', ')}</p>
                        <p><strong>Статус:</strong> {genResult.draft.status} · <strong>Версия:</strong> {genResult.draft.version}</p>
                      </div>
                    )}
                    {genDraftView === 'json' && (
                      <textarea value={genDraftJson} onChange={(e) => setGenDraftJson(e.target.value)} style={{ width: '100%', minHeight: '400px', fontFamily: 'monospace', fontSize: '13px', padding: '12px', border: '1px solid #d1d5db', borderRadius: '4px' }} />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'ai_autoplay' && isSuperuser && (
        <div style={{ maxWidth: '720px' }}>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h3 style={{ margin: '0 0 8px 0' }}>ИИ-прогон кейса</h3>
            <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
              Сессия создаётся и сохраняется от имени выбранного пользователя (роль user). Модели — из настроек ИИ (этапы 1 и 3).
              Профили задают <strong>силу симуляции</strong> (ориентир по качеству прохождения); итоговый LEXIC не подгоняется вручную — среднее по осям
              может не совпасть с «идеальными» коридорами. Алиасы API: good→мастер, random→середняк.
              Перед этапом 3, если договора ещё нет в БД, выполняется тот же автозасев из JSON кейса, что и у{' '}
              <code style={{ fontSize: '12px' }}>/api/session/negotiation/start</code>.
              Прогон идёт на сервере в фоне; страница опрашивает статус каждые несколько секунд (до ~20 мин), чтобы Safari и прокси не обрывали длинный HTTP-запрос.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
              <label style={{ fontWeight: 600, fontSize: '13px' }}>Кейс</label>
              <select
                value={autoplayCaseId}
                onChange={(e) => setAutoplayCaseId(e.target.value)}
                style={{ padding: '8px', borderRadius: '6px', border: '1px solid #d1d5db', maxWidth: '100%' }}
              >
                {autoplayCases.length === 0 && <option value="">— нет кейсов —</option>}
                {autoplayCases.map((c) => (
                  <option key={c.id} value={c.id}>{c.title || c.id}</option>
                ))}
              </select>
              <label style={{ fontWeight: 600, fontSize: '13px' }}>Пользователь (id, роль user)</label>
              <select
                value={autoplayUserId}
                onChange={(e) => setAutoplayUserId(e.target.value)}
                style={{ padding: '8px', borderRadius: '6px', border: '1px solid #d1d5db' }}
              >
                <option value="">— выберите —</option>
                {usersList.filter((u) => u.role === 'user').map((u) => (
                  <option key={u.id} value={String(u.id)}>{u.username} (id {u.id})</option>
                ))}
              </select>
              <label style={{ fontWeight: 600, fontSize: '13px' }}>Профиль</label>
              <select
                value={autoplayStyle}
                onChange={(e) => setAutoplayStyle(e.target.value)}
                style={{ padding: '8px', borderRadius: '6px', border: '1px solid #d1d5db', width: '100%', maxWidth: '420px' }}
              >
                <option value="reference">Эталон — сильная симуляция (reference)</option>
                <option value="master">Мастер — сильная с ошибками (master; был good)</option>
                <option value="average">Середняк (average; был random)</option>
                <option value="outsider">Аутсайдер — слабое прохождение</option>
                <option value="clueless">Что я здесь делаю? — провальное прохождение</option>
                <option value="good">Алиас: good → мастер</option>
                <option value="random">Алиас: random → середняк</option>
              </select>
            </div>
            {autoplayError && <div style={{ color: '#b91c1c', fontSize: '14px', marginBottom: '12px' }}>{autoplayError}</div>}
            <button
              type="button"
              onClick={handleAutoplayRun}
              disabled={autoplayLoading}
              style={{
                padding: '10px 20px',
                background: autoplayLoading ? '#9ca3af' : '#7c3aed',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: autoplayLoading ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              {autoplayLoading ? 'Выполняется…' : 'Запустить прогон'}
            </button>
            {autoplayResult && (
              <div style={{ marginTop: '20px' }}>
                <p style={{ fontSize: '14px', marginBottom: '8px' }}>
                  <strong>Сессия:</strong> {autoplayResult.session_id} · <strong>Этап:</strong> {autoplayResult.current_stage}
                  {autoplayResult.profile && (
                    <>
                      {' '}
                      · <strong>Профиль:</strong> {autoplayResult.profile}
                    </>
                  )}
                  {autoplayResult.lexic_mean != null && (
                    <>
                      {' '}
                      · <strong>Среднее LEXIC (по движку):</strong> {autoplayResult.lexic_mean}
                    </>
                  )}
                  <br />
                  <strong>LEXIC:</strong> {autoplayResult.lexic ? JSON.stringify(autoplayResult.lexic) : '—'}
                </p>
                <pre
                  style={{
                    fontSize: '12px',
                    background: '#f9fafb',
                    padding: '12px',
                    borderRadius: '8px',
                    overflow: 'auto',
                    maxHeight: '360px',
                    border: '1px solid #e5e7eb',
                  }}
                >
                  {(autoplayResult.log || []).join('\n')}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'contract_consistency' && isSuperuser && (
        <div style={{ maxWidth: '960px' }}>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h3 style={{ margin: '0 0 8px 0' }}>Сверка договора: этап 2 и этап 3</h3>
            <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
              Сравниваются нумерованные пункты в{' '}
              <code style={{ fontSize: '12px' }}>data/cases/&lt;кейс&gt;/stage-2/contract.json</code> и в{' '}
              <code style={{ fontSize: '12px' }}>stage-3/Contract_PO.md</code> (или <code style={{ fontSize: '12px' }}>dogovor_PO.md</code>).
              Тексты приводятся к одному виду (пробелы, снятие префикса номера в MD, снятие заголовков <code>##</code> разделов в JSON).
              Доступно только роли <strong>superuser</strong>.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px', maxWidth: '520px' }}>
              <label style={{ fontWeight: 600, fontSize: '13px' }}>Кейс</label>
              <select
                value={contractCheckCaseId}
                onChange={(e) => setContractCheckCaseId(e.target.value)}
                style={{ padding: '8px', borderRadius: '6px', border: '1px solid #d1d5db' }}
              >
                {contractCheckCases.length === 0 && <option value="">— нет кейсов —</option>}
                {contractCheckCases.map((c) => (
                  <option key={c.id} value={c.id}>{c.title || c.id}</option>
                ))}
              </select>
            </div>
            {contractCheckError && (
              <div style={{ color: '#b91c1c', fontSize: '14px', marginBottom: '12px' }}>{contractCheckError}</div>
            )}
            <button
              type="button"
              onClick={handleContractConsistencyRun}
              disabled={contractCheckLoading}
              style={{
                padding: '10px 20px',
                background: contractCheckLoading ? '#9ca3af' : '#0d9488',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: contractCheckLoading ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              {contractCheckLoading ? 'Проверка…' : 'Проверить расхождения'}
            </button>
            {contractCheckResult && !contractCheckResult.error && (
              <div style={{ marginTop: '20px', fontSize: '14px' }}>
                <p style={{ margin: '0 0 8px 0' }}>
                  <strong>Итог:</strong>{' '}
                  {contractCheckResult.ok ? (
                    <span style={{ color: '#059669' }}>расхождений по общим пунктам не найдено</span>
                  ) : (
                    <span style={{ color: '#b45309' }}>есть отличия — см. ниже</span>
                  )}
                  {contractCheckResult.compared_clause_count != null && (
                    <span style={{ color: '#6b7280' }}>
                      {' '}
                      (сопоставлено пунктов: {contractCheckResult.compared_clause_count})
                    </span>
                  )}
                </p>
                {contractCheckResult.paths && (
                  <ul style={{ margin: '0 0 12px 0', paddingLeft: '20px', color: '#4b5563', fontSize: '13px' }}>
                    {contractCheckResult.paths.stage2_contract_json && (
                      <li><strong>Этап 2:</strong> {contractCheckResult.paths.stage2_contract_json}</li>
                    )}
                    {contractCheckResult.paths.contract_md && (
                      <li><strong>Этап 3 (MD):</strong> {contractCheckResult.paths.contract_md}</li>
                    )}
                  </ul>
                )}
                {Array.isArray(contractCheckResult.warnings) && contractCheckResult.warnings.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <strong style={{ color: '#92400e' }}>Предупреждения парсера MD</strong>
                    <ul style={{ margin: '4px 0 0 0', paddingLeft: '20px', color: '#78350f', fontSize: '13px' }}>
                      {contractCheckResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {Array.isArray(contractCheckResult.only_in_stage2_contract_json) &&
                  contractCheckResult.only_in_stage2_contract_json.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <strong style={{ color: '#b91c1c' }}>Только в stage-2/contract.json (нет такого номера в MD)</strong>
                    <div style={{ fontFamily: 'monospace', fontSize: '13px', marginTop: '6px' }}>
                      {contractCheckResult.only_in_stage2_contract_json.join(', ')}
                    </div>
                  </div>
                )}
                {Array.isArray(contractCheckResult.only_in_contract_md) &&
                  contractCheckResult.only_in_contract_md.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <strong style={{ color: '#b91c1c' }}>Только в Contract_PO.md (нет такого id в JSON этапа 2)</strong>
                    <div style={{ fontFamily: 'monospace', fontSize: '13px', marginTop: '6px' }}>
                      {contractCheckResult.only_in_contract_md.join(', ')}
                    </div>
                  </div>
                )}
                {Array.isArray(contractCheckResult.mismatches) && contractCheckResult.mismatches.length > 0 && (
                  <div style={{ marginTop: '12px' }}>
                    <strong style={{ color: '#b91c1c' }}>Разный текст у общих пунктов</strong>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
                      {contractCheckResult.mismatches.map((m) => (
                        <div
                          key={m.clause_id}
                          style={{
                            border: '1px solid #fecaca',
                            borderRadius: '8px',
                            padding: '12px',
                            background: '#fff7ed',
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: '6px' }}>Пункт {m.clause_id}</div>
                          {m.hint && <div style={{ fontSize: '13px', color: '#57534e', marginBottom: '8px' }}>{m.hint}</div>}
                          <div style={{ fontSize: '12px', color: '#44403c' }}>
                            <div style={{ fontWeight: 600, marginBottom: '4px' }}>После нормализации, этап 2 (JSON)</div>
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                background: '#fff',
                                padding: '8px',
                                borderRadius: '4px',
                                border: '1px solid #e7e5e4',
                                maxHeight: '160px',
                                overflow: 'auto',
                              }}
                            >
                              {m.stage2_text_normalized || '—'}
                            </pre>
                          </div>
                          <div style={{ fontSize: '12px', color: '#44403c', marginTop: '10px' }}>
                            <div style={{ fontWeight: 600, marginBottom: '4px' }}>После нормализации, этап 3 (MD)</div>
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                background: '#fff',
                                padding: '8px',
                                borderRadius: '4px',
                                border: '1px solid #e7e5e4',
                                maxHeight: '160px',
                                overflow: 'auto',
                              }}
                            >
                              {m.contract_md_text_normalized || '—'}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {contractCheckResult && contractCheckResult.error && (
              <div style={{ marginTop: '16px', color: '#b91c1c', fontSize: '14px' }}>
                {contractCheckResult.error}
                {contractCheckResult.paths?.contract_md_attempts && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#6b7280' }}>
                    Искали: {contractCheckResult.paths.contract_md_attempts.join('; ')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div style={{ maxWidth: '800px' }}>
          {isSuperuser && (
            <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '20px' }}>
              <h3 style={{ margin: '0 0 12px 0' }}>Группы</h3>
              <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>
                Группы создаёт только суперюзер. Для новых admin и user нужно выбрать группу ниже.
              </p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="Название группы"
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', minWidth: '200px' }}
                />
                <button
                  type="button"
                  onClick={handleCreateGroup}
                  style={{ padding: '8px 14px', background: '#6366f1', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Создать группу
                </button>
              </div>
              {groupCreateError && <div style={{ color: '#dc2626', fontSize: '13px', marginBottom: '8px' }}>{groupCreateError}</div>}
              {groupsList.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: '#374151' }}>
                  {groupsList.map((g) => (
                    <li key={g.id}>{g.name} <span style={{ color: '#9ca3af' }}>(id {g.id})</span></li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '20px' }}>
            <h3 style={{ margin: '0 0 16px 0' }}>Новый пользователь</h3>
            <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>
              {isSuperuser
                ? 'Суперюзер создаёт группы и назначает группу для ролей admin и user. Для superuser группа не задаётся.'
                : 'Вы создаёте пользователей и админов в своей группе. Удалить другого админа нельзя — только участников (user).'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>Логин</label>
                <input
                  type="text"
                  value={userForm.username}
                  onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="username"
                  style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>Пароль</label>
                <input
                  type="password"
                  value={userForm.password}
                  onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="не менее 4 символов"
                  style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
                />
              </div>
            </div>
            {isSuperuser && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>Роль</label>
                <select
                  value={userForm.role}
                  onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', minWidth: '140px' }}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                  <option value="superuser">superuser</option>
                </select>
              </div>
            )}
            {!isSuperuser && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>Роль</label>
                <select
                  value={userForm.role}
                  onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', minWidth: '200px' }}
                >
                  <option value="user">user (участник)</option>
                  <option value="admin">admin (админ группы)</option>
                </select>
              </div>
            )}
            {isSuperuser && userForm.role !== 'superuser' && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>Группа</label>
                <select
                  value={userForm.group_id}
                  onChange={(e) => setUserForm((f) => ({ ...f, group_id: e.target.value }))}
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px', minWidth: '220px' }}
                >
                  <option value="">— выберите группу —</option>
                  {groupsList.map((g) => (
                    <option key={g.id} value={String(g.id)}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '13px' }}>Email (опционально)</label>
              <input
                type="text"
                value={userForm.email}
                onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
                style={{ width: '100%', maxWidth: '280px', padding: '8px', border: '1px solid #d1d5db', borderRadius: '4px' }}
              />
            </div>
            {userCreateError && <div style={{ color: '#dc2626', fontSize: '13px', marginBottom: '8px' }}>{userCreateError}</div>}
            <button
              onClick={handleCreateUser}
              disabled={userCreateStatus === 'loading'}
              style={{
                padding: '8px 16px',
                background: userCreateStatus === 'loading' ? '#9ca3af' : '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: userCreateStatus === 'loading' ? 'not-allowed' : 'pointer',
              }}
            >
              {userCreateStatus === 'loading' ? 'Создание…' : userCreateStatus === 'ok' ? 'Создан' : 'Создать пользователя'}
            </button>
          </div>
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h3 style={{ margin: '0 0 12px 0' }}>Список пользователей</h3>
            {usersLoading && <p style={{ color: '#6b7280' }}>Загрузка…</p>}
            {!usersLoading && usersList.length === 0 && <p style={{ color: '#6b7280' }}>Нет пользователей.</p>}
            {!usersLoading && usersList.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e5e7eb' }}>Логин</th>
                    <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e5e7eb' }}>Роль</th>
                    <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e5e7eb' }}>Группа</th>
                    <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e5e7eb' }}>Email</th>
                    <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #e5e7eb' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {usersList.map((u) => (
                    <tr key={u.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px' }}>{u.username}</td>
                      <td style={{ padding: '8px' }}>{u.role}</td>
                      <td style={{ padding: '8px', color: '#6b7280' }}>{u.group_name || (u.group_id != null ? `#${u.group_id}` : '—')}</td>
                      <td style={{ padding: '8px', color: '#6b7280' }}>{u.email || '—'}</td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        {currentUser && u.id !== currentUser.id && (isSuperuser || u.role === 'user') && (
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(u.id)}
                            style={{ padding: '4px 10px', fontSize: '12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '4px', cursor: 'pointer' }}
                          >
                            Удалить
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'reports' && (
        <div style={{ maxWidth: '900px' }}>
          <h3 style={{ margin: '0 0 16px 0' }}>Отчёты пользователей (роль user)</h3>
          {reportsLoading && <p style={{ color: '#6b7280' }}>Загрузка…</p>}
          {!reportsLoading && reportsByUser.length === 0 && (
            <p style={{ color: '#6b7280' }}>Нет пользователей с ролью user или у них пока нет сессий.</p>
          )}
          {!reportsLoading && reportsByUser.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {reportsByUser.map(({ user_id, username, sessions }) => (
                <div
                  key={user_id}
                  style={{
                    background: 'white',
                    padding: '16px 20px',
                    borderRadius: '8px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                  }}
                >
                  <h4 style={{ margin: '0 0 12px 0', fontSize: '16px', color: '#1f2937' }}>{username}</h4>
                  {sessions.length === 0 ? (
                    <p style={{ margin: 0, fontSize: '13px', color: '#6b7280' }}>Нет сессий</p>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {sessions.map((s) => (
                        <li
                          key={s.session_id}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '10px 0',
                            borderBottom: '1px solid #f3f4f6',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: 500, color: '#374151' }}>{s.case_title || s.case_code || 'Кейс'}</span>
                            <span style={{ fontSize: '13px', color: '#6b7280', marginLeft: '8px' }}>
                              этап {s.current_stage ?? '—'} · {s.created_at ? new Date(s.created_at).toLocaleString('ru-RU') : ''}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => openReportModal(s.session_id, username)}
                            style={{
                              padding: '6px 12px',
                              background: '#3b82f6',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              fontSize: '13px',
                            }}
                          >
                            Открыть отчёт
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'cases' && (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '20px' }}>
          <div style={{ background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', height: 'fit-content' }}>
            <h3 style={{ margin: '0 0 12px 0' }}>Кейсы</h3>
            <button
              onClick={async () => {
                setReseedCasesStatus('loading');
                try {
                  const res = await fetch(`${getAdminApiUrl()}/reseed-cases`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: getAdminHeaders(),
                  });
                  if (!res.ok) throw new Error(await res.text());
                  setReseedCasesStatus('ok');
                  loadCases();
                  setTimeout(() => setReseedCasesStatus(null), 3000);
                } catch (e) {
                  handleApiError(e, false);
                  setReseedCasesStatus('error');
                  setTimeout(() => setReseedCasesStatus(null), 3000);
                }
              }}
              disabled={reseedCasesStatus === 'loading'}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: reseedCasesStatus === 'ok' ? '#059669' : reseedCasesStatus === 'loading' ? '#9ca3af' : '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: reseedCasesStatus === 'loading' ? 'not-allowed' : 'pointer',
                marginBottom: '8px',
                fontSize: '13px',
              }}
            >
              {reseedCasesStatus === 'loading' ? 'Синхронизация…' : reseedCasesStatus === 'ok' ? 'Готово' : 'Синхронизировать с файлами'}
            </button>
            <button
              onClick={handleNewCase}
              style={{ width: '100%', padding: '10px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginBottom: '12px' }}
            >
              + Новый кейс
            </button>
            {loadingList ? (
              <p style={{ color: '#6b7280' }}>Загрузка…</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {cases.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSelectCase(c)}
                    style={{
                      padding: '10px',
                      textAlign: 'left',
                      background: selectedCase?.id === c.id ? '#dbeafe' : '#f9fafb',
                      border: selectedCase?.id === c.id ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{c.title}</div>
                    <div style={{ fontSize: '12px', color: '#6b7280' }}>v{c.version} · {c.status}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            {loadingCase && !selectedCase && <p>Загрузка кейса…</p>}
            {!loadingCase && !selectedCase && (
              <div style={{ textAlign: 'center', color: '#9ca3af', padding: '60px 20px' }}>
                Выберите кейс слева или создайте новый.
              </div>
            )}

            {selectedCase && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                  <h2 style={{ margin: 0 }}>{selectedCase.title}</h2>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                    {saveStatus === 'ok' && <span style={{ color: '#059669' }}>Сохранено</span>}
                    {saveStatus === 'error' && <span style={{ color: '#dc2626' }}>Ошибка сохранения</span>}
                    {caseDirty && <span style={{ fontSize: '12px', color: '#b45309', marginRight: '4px' }}>Есть несохранённые изменения</span>}
                    <button type="button" onClick={handleSaveCase} disabled={saveStatus === 'saving'} style={{ padding: '8px 16px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: saveStatus === 'saving' ? 'not-allowed' : 'pointer' }}>
                      {saveStatus === 'saving' ? 'Сохранение…' : 'Сохранить'}
                    </button>
                    <button type="button" onClick={() => openFileModal('documentation.md')} style={{ padding: '8px 16px', background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                      Методичка (файл)
                    </button>
                    <button type="button" onClick={() => { setJsonEditor(JSON.stringify(selectedCase, null, 2)); setView('json-editor'); }} style={{ padding: '8px 16px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                      Редактировать JSON
                    </button>
                    <span style={{ width: '1px', height: '24px', background: '#e5e7eb', margin: '0 4px', display: 'inline-block' }} aria-hidden />
                    <span style={{ fontSize: '12px', color: '#64748b', marginRight: '4px' }}>Вид:</span>
                    <button
                      type="button"
                      onClick={() => setCaseEditorMode('classic')}
                      style={{
                        padding: '8px 12px',
                        fontSize: '12px',
                        border: caseEditorMode === 'classic' ? '2px solid #3b82f6' : '1px solid #d1d5db',
                        borderRadius: '4px',
                        background: caseEditorMode === 'classic' ? '#dbeafe' : '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      Классический
                    </button>
                    <button
                      type="button"
                      onClick={() => setCaseEditorMode('studio')}
                      style={{
                        padding: '8px 12px',
                        fontSize: '12px',
                        border: caseEditorMode === 'studio' ? '2px solid #3b82f6' : '1px solid #d1d5db',
                        borderRadius: '4px',
                        background: caseEditorMode === 'studio' ? '#dbeafe' : '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      Студия
                    </button>
                  </div>
                </div>

                {caseEditorMode === 'studio' ? (
                  <CaseEditorShell
                    selectedCase={selectedCase}
                    validationErrors={validationErrors}
                    onOpenMethodologyFile={() => openFileModal('documentation.md')}
                    openFileModal={openFileModal}
                    updateCase={updateCase}
                    dependencyRefreshKey={caseDependencyRefreshKey}
                    methodologyDoc={methodologyDoc}
                    expandedStages={expandedStages}
                    toggleStage={toggleStage}
                    updateStage={updateStage}
                    onOpenStageSelector={() => { setEditingCase(selectedCase); setShowStageSelector(true); }}
                    caseDirty={caseDirty}
                  />
                ) : (
                  <CaseEditorClassic
                    selectedCase={selectedCase}
                    validationErrors={validationErrors}
                    updateCase={updateCase}
                    updateStage={updateStage}
                    expandedStages={expandedStages}
                    toggleStage={toggleStage}
                    openFileModal={openFileModal}
                    methodologyDoc={methodologyDoc}
                    onOpenStageSelector={() => { setEditingCase(selectedCase); setShowStageSelector(true); }}
                    dependencyRefreshKey={caseDependencyRefreshKey}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showStageSelector && (
        <StageSelector
          selectedStages={editingCase?.stages?.map((s) => s.id) ?? newCaseStages.map((s) => s.id) ?? []}
          onStagesChange={(stages) => setNewCaseStages(stages)}
          onCancel={() => { setShowStageSelector(false); setEditingCase(null); setNewCaseStages([]); }}
          onConfirm={handleStageSelectorConfirm}
        />
      )}

      {fileModal?.path && (fileModal.caseId || selectedCase?.id) && (
        <AdminFileModal
          caseId={fileModal.caseId || selectedCase.id}
          path={fileModal.path}
          onClose={closeFileModal}
          onSaved={() => {
            setCaseDependencyRefreshKey((k) => k + 1);
            if (
              fileModal?.path === 'documentation.md'
              && (!fileModal.caseId || fileModal.caseId === selectedCase?.id)
            ) {
              setMethodologyBump((n) => n + 1);
            }
          }}
        />
      )}

      {(reportModalLoading || reportModalError || reportModal) && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !reportModalLoading) { setReportModal(null); setReportModalError(null); } }}
        >
          <div
            style={{
              background: 'white',
              borderRadius: '12px',
              maxWidth: '1000px',
              width: '100%',
              maxHeight: '95vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: '#1f2937' }}>
                {reportModal ? `Отчёт · ${reportModal.username}` : reportModalError ? 'Ошибка' : 'Загрузка отчёта…'}
              </span>
              <button
                type="button"
                onClick={() => { setReportModal(null); setReportModalError(null); }}
                disabled={reportModalLoading}
                style={{ padding: '6px 12px', background: '#6b7280', color: 'white', border: 'none', borderRadius: '6px', cursor: reportModalLoading ? 'not-allowed' : 'pointer' }}
              >
                Закрыть
              </button>
            </div>
            {reportModalLoading && (
              <div style={{ padding: '48px 24px', textAlign: 'center', color: '#6b7280' }}>Формирование итогового отчёта…</div>
            )}
            {reportModalError && (
              <div style={{ padding: '24px', color: '#b91c1c' }}>{reportModalError}</div>
            )}
            {reportModal && reportModal.report && (
              <ReportView
                report={reportModal.report}
                caseData={reportModal.caseData}
                viewerUser={currentUser}
                showRestart={false}
                onRestart={() => {}}
                onBackToStart={() => { setReportModal(null); }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
