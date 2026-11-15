'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { HandwritingSvg } from './HandwritingSvg';

const SESSION_KEY = 'safezone:greeted';

/**
 * Приветствие при входе — как у Ауры: надпись пишется от руки поверх живого фона,
 * один раз за сессию браузера. Сначала по-английски, затем по-русски.
 * Клик или любая клавиша пропускают его.
 */
export function SafeZoneGreeting({ name }: { name?: string | null }) {
  const reduce = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, '1');
    } catch {
      return;
    }
    setVisible(true);
  }, []);

  const close = useCallback(() => setVisible(false), []);

  useEffect(() => {
    if (!visible) return;
    const onKey = () => close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, close]);

  useEffect(() => {
    if (!visible || step < 2) return;
    const t = window.setTimeout(close, reduce ? 900 : 1800);
    return () => window.clearTimeout(t);
  }, [visible, step, reduce, close]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="safezone-greeting"
          role="dialog"
          aria-modal="true"
          aria-label="Welcome to SafeZone — Добро пожаловать в SafeZone"
          className="fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center gap-2 bg-[rgba(6,8,30,0.45)] px-6 text-[#eef3ff]"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: reduce ? 0.2 : 0.7, ease: 'easeOut' } }}
          onClick={close}
        >
          <HandwritingSvg
            text="Welcome to SafeZone"
            fontSize={88}
            width={760}
            height={140}
            strokeWidth={1.2}
            duration={2.2}
            delay={0.3}
            fillAfter
            className="h-auto w-[min(760px,90vw)] text-[#eef3ff] drop-shadow-[0_0_24px_rgba(150,215,255,0.35)]"
            onComplete={() => setStep(s => Math.max(s, 1))}
          />
          {step >= 1 && (
            <HandwritingSvg
              text="Добро пожаловать в SafeZone"
              fontSize={60}
              width={760}
              height={100}
              strokeWidth={1}
              duration={2}
              delay={0.1}
              fillAfter
              className="h-auto w-[min(640px,84vw)] text-[#96d7ff] drop-shadow-[0_0_18px_rgba(150,215,255,0.3)]"
              onComplete={() => setStep(2)}
            />
          )}
          <motion.p
            className="mt-2 max-w-md text-center text-base text-[#a9b8de] sm:text-lg"
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={step >= 2 ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            {name ? `${name}, Аура на страже вашего объекта` : 'Аура на страже вашего объекта'}
          </motion.p>
          <span className="sr-only">Нажмите любую клавишу, чтобы продолжить</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
