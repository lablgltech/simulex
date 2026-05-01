import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  readWelcomeOverlaySlideSnapshot,
  writeWelcomeOverlaySlideSnapshot,
  clearWelcomeOverlaySlideStorage,
} from '../utils/simulatorWelcomeStorage';
import './SimulatorWelcomeOverlay.css';

const DEFAULT_STEP_LABELS = ['Старт', 'О симуляторе', 'Кейс'];
const DEFAULT_MAIN_AUTO_MS_0_TO_1 = 5000;
const DEFAULT_MAIN_AUTO_MS_1_TO_2 = 15000;
const DEFAULT_COMIC_REVEAL_MS = 720;

/** Кривая «ease out expo» в духе современных UI (linear-ish fast end). */
const SLIDE_EASE = [0.16, 1, 0.3, 1];

const slideBodyTransition = {
  duration: 0.52,
  ease: SLIDE_EASE,
};

const slideExitTransition = {
  duration: 0.38,
  ease: SLIDE_EASE,
};

const slideBodyVariantsMotion = {
  initial: (dir) => ({
    opacity: 0,
    x: dir > 0 ? 52 : dir < 0 ? -52 : 0,
    scale: 0.968,
  }),
  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: slideBodyTransition,
  },
  exit: (dir) => ({
    opacity: 0,
    x: dir > 0 ? -44 : dir < 0 ? 44 : 0,
    scale: 0.985,
    transition: slideExitTransition,
  }),
};

const slideBodyVariantsReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.22, ease: SLIDE_EASE } },
  exit: { opacity: 0, transition: { duration: 0.18, ease: SLIDE_EASE } },
};

/** После ручного переключения вкладок: без слайда/scale, только лёгкий кроссфейд. */
const slideBodyVariantsManualSnap = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.09, ease: SLIDE_EASE } },
  exit: { opacity: 0, transition: { duration: 0.07, ease: SLIDE_EASE } },
};

/**
 * Полноэкранное приветствие (только 4-этапный кейс): без полупрозрачности и «карточки».
 * Переходы между шагами — Framer Motion (AnimatePresence + направленный слайд).
 */
export default function SimulatorWelcomeOverlay({
  introConfig,
  comicPanels,
  /** Восстановление слайда после F5 — привязка к сессии и кейсу */
  persistenceSessionId = null,
  persistenceCaseId = null,
  onContinue,
  onSkip,
  onSetSkipNextLaunch,
}) {
  const slideSnap = readWelcomeOverlaySlideSnapshot(persistenceSessionId, persistenceCaseId);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [mainIndex, setMainIndex] = useState(() => slideSnap?.mainIndex ?? 0);
  const [slideDir, setSlideDir] = useState(() => slideSnap?.slideDir ?? 1);
  const [revealedCount, setRevealedCount] = useState(() => slideSnap?.revealedCount ?? 0);
  /** Пользователь сам переключил шаг (вкладки или «Далее») — автоскролл слайдов отключается, богатая анимация слайдов — один раз до этого. */
  const [manualTakeover, setManualTakeover] = useState(() => !!slideSnap?.manualTakeover);
  const skipMainAutoRef = useRef(false);
  const skipComicRevealRef = useRef(false);
  const revealedCountRef = useRef(revealedCount);
  revealedCountRef.current = revealedCount;
  const reduceMotion = useReducedMotion();
  const stepLabels = introConfig?.step_labels || DEFAULT_STEP_LABELS;
  const welcomeConfig = introConfig?.part_welcome || {};
  const aboutConfig = introConfig?.part_about || {};
  const comicConfig = introConfig?.part_comic || {};
  const timings = introConfig?.timings || {};
  const autoDelayFirst = Number(timings.main_auto_ms_0_to_1) || DEFAULT_MAIN_AUTO_MS_0_TO_1;
  const autoDelaySecond = Number(timings.main_auto_ms_1_to_2) || DEFAULT_MAIN_AUTO_MS_1_TO_2;
  const comicRevealMs = Number(timings.comic_reveal_ms) || DEFAULT_COMIC_REVEAL_MS;

  const bodyVariants = useMemo(() => {
    if (reduceMotion) return slideBodyVariantsReduced;
    if (manualTakeover) return slideBodyVariantsManualSnap;
    return slideBodyVariantsMotion;
  }, [reduceMotion, manualTakeover]);

  const applySkipFlag = () => {
    if (dontShowAgain && typeof onSetSkipNextLaunch === 'function') {
      onSetSkipNextLaunch(true);
    }
  };

  const wipeSlideStorage = useCallback(() => {
    clearWelcomeOverlaySlideStorage(persistenceSessionId, persistenceCaseId);
  }, [persistenceSessionId, persistenceCaseId]);

  useEffect(() => {
    writeWelcomeOverlaySlideSnapshot(persistenceSessionId, persistenceCaseId, {
      mainIndex,
      revealedCount,
      manualTakeover,
      slideDir,
    });
  }, [persistenceSessionId, persistenceCaseId, mainIndex, revealedCount, manualTakeover, slideDir]);

  const goMain = useCallback((idx, direction) => {
    if (idx === mainIndex) return;
    setManualTakeover(true);
    skipMainAutoRef.current = true;
    skipComicRevealRef.current = true;
    const d =
      direction !== undefined ? direction : idx > mainIndex ? 1 : idx < mainIndex ? -1 : 1;
    setSlideDir(d);
    setMainIndex(idx);
    setRevealedCount(0);
  }, [mainIndex]);

  useEffect(() => {
    skipMainAutoRef.current = false;
  }, [mainIndex]);

  useEffect(() => {
    if (manualTakeover) return undefined;
    if (mainIndex >= 2) return undefined;
    const delay = mainIndex === 0 ? autoDelayFirst : autoDelaySecond;
    const t = window.setTimeout(() => {
      if (skipMainAutoRef.current) return;
      setSlideDir(1);
      setMainIndex((i) => {
        const next = i < 2 ? i + 1 : i;
        return next;
      });
    }, delay);
    return () => window.clearTimeout(t);
  }, [mainIndex, manualTakeover, autoDelayFirst, autoDelaySecond]);

  useEffect(() => {
    if (mainIndex !== 2) {
      setRevealedCount(0);
      return undefined;
    }
    const n = comicPanels.length;
    if (n === 0) return undefined;
    const start = Math.min(revealedCountRef.current, n);
    if (start >= n) {
      skipComicRevealRef.current = true;
      return undefined;
    }
    skipComicRevealRef.current = false;
    const timers = [];
    for (let k = start + 1; k <= n; k += 1) {
      const tid = window.setTimeout(() => {
        if (skipComicRevealRef.current) return;
        setRevealedCount(k);
      }, comicRevealMs * (k - start));
      timers.push(tid);
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [mainIndex, comicPanels.length, comicRevealMs]);

  const comicReady = mainIndex === 2 && revealedCount >= comicPanels.length;

  const revealUpTo = (idx) => {
    skipComicRevealRef.current = true;
    setRevealedCount(Math.max(1, idx + 1));
  };

  return (
    <div
      className="sim-intro-fs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sim-intro-welcome-title"
    >
      <nav className="sim-intro-stepnav" aria-label="Шаги приветствия">
        {stepLabels.map((label, i) => (
          <button
            key={label}
            type="button"
            className={mainIndex === i ? 'is-active' : ''}
            aria-current={mainIndex === i ? 'step' : undefined}
            onClick={() => goMain(i)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="sim-intro-body sim-intro-body--motion">
        <AnimatePresence mode="wait" initial={false} custom={reduceMotion ? 0 : slideDir}>
          {mainIndex === 0 && (
            <motion.div
              key="intro-slide-0"
              role="group"
              aria-roledescription="slide"
              custom={reduceMotion ? 0 : slideDir}
              variants={bodyVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="sim-intro-slide-fill sim-intro-slide-welcome sim-intro-motion-layer"
            >
              <h1 id="sim-intro-welcome-title" className="sim-intro-welcome-title">
                {welcomeConfig.title}
              </h1>
              {welcomeConfig.subtitle ? (
                <p
                  className={`sim-intro-welcome-sub${manualTakeover ? ' sim-intro-welcome-sub--static' : ''}`}
                >
                  {welcomeConfig.subtitle}
                </p>
              ) : null}
            </motion.div>
          )}

          {mainIndex === 1 && (
            <motion.div
              key="intro-slide-1"
              role="group"
              aria-roledescription="slide"
              custom={reduceMotion ? 0 : slideDir}
              variants={bodyVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="sim-intro-slide-fill sim-intro-motion-layer"
            >
              <div className="sim-intro-about-grid">
                <div className="sim-intro-about-text">
                  <h2>{aboutConfig.title}</h2>
                  {(aboutConfig.lines || []).map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
                <div className="sim-intro-hero">
                  {aboutConfig.hero_image_src ? (
                    <img
                      src={aboutConfig.hero_image_src}
                      alt={aboutConfig.hero_image_alt || ''}
                    />
                  ) : (
                    <div
                      className="sim-intro-comic-placeholder"
                      style={{ aspectRatio: '4/3', maxHeight: '52vh' }}
                      aria-hidden
                    >
                      ·
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {mainIndex === 2 && comicPanels.length > 0 && (
            <motion.div
              key="intro-slide-2"
              role="group"
              aria-roledescription="slide"
              custom={reduceMotion ? 0 : slideDir}
              variants={bodyVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="sim-intro-slide-fill sim-intro-motion-layer"
            >
              <div className="sim-intro-comic-block">
                <h2 className="sim-intro-comic-title">{comicConfig.title}</h2>
                <div className="sim-intro-comic-grid">
                  {comicPanels.map((panel, i) => {
                    const visible = revealedCount >= i + 1;
                    return (
                      <button
                        key={panel.stageOrder}
                        type="button"
                        className="sim-intro-comic-row"
                        onClick={() => revealUpTo(i)}
                        aria-label={`Показать кадр ${i + 1}: ${panel.heading}`}
                      >
                        <div className="sim-intro-comic-frame">
                          <div className={`sim-intro-comic-frame-inner${visible ? ' is-visible' : ''}`}>
                            {panel.imageSrc ? (
                              <img
                                src={panel.imageSrc}
                                alt={`Иллюстрация этапа ${panel.stageOrder}: ${panel.heading}`}
                              />
                            ) : (
                              <div className="sim-intro-comic-placeholder">{panel.stageOrder}</div>
                            )}
                          </div>
                        </div>
                        <div className="sim-intro-comic-caption">
                          <strong>{panel.heading}</strong>
                          {panel.caption || '—'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <footer className="sim-intro-footer">
        <label>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Не показывать приветствие при старте кейса
        </label>
        <div className="sim-intro-footer-actions">
          <button
            type="button"
            className="sim-intro-btn-ghost"
            onClick={() => {
              wipeSlideStorage();
              applySkipFlag();
              onSkip?.();
            }}
          >
            Пропустить
          </button>
          {mainIndex < 2 && (
            <button type="button" className="sim-intro-btn-secondary" onClick={() => goMain(mainIndex + 1, 1)}>
              Далее
            </button>
          )}
          {mainIndex === 2 && !comicReady && (
            <button
              type="button"
              className="sim-intro-btn-secondary"
              onClick={() => {
                skipComicRevealRef.current = true;
                setRevealedCount(comicPanels.length);
              }}
            >
              Показать все кадры
            </button>
          )}
          {mainIndex === 2 && comicReady && (
            <button
              type="button"
              className="sim-intro-btn-primary"
              onClick={() => {
                wipeSlideStorage();
                applySkipFlag();
                onContinue?.();
              }}
            >
              Начать кейс
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
