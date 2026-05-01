import React, { useState, useEffect, useRef, useCallback } from 'react';
import './ReportLoadingOverlay.css';

const PHRASES = [
  'Подсчитываем ваши юридические таланты\u2026',
  'Взвешиваем аргументы на весах Фемиды\u2026',
  'Пересчитываем баллы третий раз \u2014 на всякий случай\u2026',
  'Конвертируем красноречие в цифры\u2026',
  'Ищем параграф, где вы были особенно убедительны\u2026',
  'Сверяем ваш договор с эталоном из параллельной вселенной\u2026',
  'Просим ИИ не завышать оценки\u2026',
  'Калибруем шкалу справедливости\u2026',
  'Анализируем, сколько раз контрагент вздохнул\u2026',
  'Составляем отчёт, которым можно гордиться\u2026',
];

const HISTORY_SIZE = 6;
const INTERVAL_MS = 3000;

function pickNext(historyRef) {
  const blocked = new Set(historyRef.current);
  const candidates = PHRASES.map((_, i) => i).filter((i) => !blocked.has(i));
  const pool = candidates.length > 0 ? candidates : PHRASES.map((_, i) => i);
  const idx = pool[Math.floor(Math.random() * pool.length)];
  historyRef.current = [...historyRef.current.slice(-(HISTORY_SIZE - 1)), idx];
  return idx;
}

export default function ReportLoadingOverlay() {
  const historyRef = useRef([]);
  const [phraseIdx, setPhraseIdx] = useState(() => pickNext(historyRef));
  const [animKey, setAnimKey] = useState(0);

  const advance = useCallback(() => {
    setPhraseIdx(pickNext(historyRef));
    setAnimKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const id = setInterval(advance, INTERVAL_MS);
    return () => clearInterval(id);
  }, [advance]);

  return (
    <div className="report-loading-overlay">
      <div className="report-loading-spinner" />
      <div className="report-loading-phrase">
        <span className="report-loading-phrase-text" key={animKey}>
          {PHRASES[phraseIdx]}
        </span>
      </div>
    </div>
  );
}
