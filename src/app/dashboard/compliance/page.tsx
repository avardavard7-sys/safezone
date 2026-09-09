'use client';

/**
 * Регламент видеоконтроля — какие пункты проверяем и как часто.
 *
 * Правки уходят в таблицу compliance_checks, бридж забирает их на ближайшем
 * heartbeat. Перезапускать его не нужно.
 */

import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, StatCard } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { ClipboardCheck, Cloud, Cpu } from 'lucide-react';

type Check = {
  id: string;
  code: string;
  title: string;
  zone_label: string | null;
  mode: 'continuous' | 'snapshot';
  engine: 'local' | 'cloud';
  enabled: boolean;
  interval_min: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  threshold_sec: number | null;
  prompt_hint: string | null;
};

const INTERVALS = [15, 30, 45, 60, 120, 240];

export default function CompliancePage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const sb = createClient();
      const { data, error } = await sb.from('compliance_checks').select('*').order('code');
      if (error) setError(error.message);
      else setChecks((data as Check[]) ?? []);
      setLoading(false);
    })();
  }, []);

  async function patch(id: string, fields: Partial<Check>) {
    const before = checks;
    setChecks(cs => cs.map(c => (c.id === id ? { ...c, ...fields } : c)));
    setSaving(id);
    const sb = createClient();
    const { error } = await sb
      .from('compliance_checks')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id);
    setSaving(null);
    if (error) {
      setChecks(before);              // не сохранилось — возвращаем как было
      setError(`Не сохранилось: ${error.message}`);
    } else {
      setError(null);
    }
  }

  const local = checks.filter(c => c.engine === 'local');
  const cloud = checks.filter(c => c.engine === 'cloud');

  // Грубая оценка расхода: непрерывные пункты дают порядка 20 обращений в час,
  // снимки — 60/интервал. Нужна, чтобы цена была видна до включения.
  const perHour = cloud
    .filter(c => c.enabled)
    .reduce((n, c) => n + (c.mode === 'continuous' ? 20 : 60 / c.interval_min), 0);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="text-slate-400">Загружаю пункты регламента…</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold font-display text-white">Регламент видеоконтроля</h1>
          <p className="text-slate-400 mt-1">
            Что система проверяет и как часто. Бридж подхватывает изменения за несколько
            секунд — перезапускать не нужно.
          </p>
        </div>

        {error && (
          <div className="glass-card p-4 border border-danger/40 text-red-400">{error}</div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            title="Пунктов включено"
            value={`${checks.filter(c => c.enabled).length} / ${checks.length}`}
            icon={<ClipboardCheck size={18} />}
          />
          <StatCard
            title="Считается локально"
            value={local.filter(c => c.enabled).length}
            subtitle="бесплатно, без облака"
            color="success"
            icon={<Cpu size={18} />}
          />
          <StatCard
            title="Обращений в облако"
            value={`≈ ${Math.round(perHour)}/час`}
            subtitle="меньше, если сцена не меняется"
            color="accent"
            icon={<Cloud size={18} />}
          />
        </div>

        <Section
          title="Локальные проверки"
          note="Считает компьютер объекта. Облако не участвует — стоимость нулевая при любой частоте."
        >
          {local.map(c => <Row key={c.id} check={c} saving={saving === c.id} onPatch={patch} />)}
        </Section>

        <Section
          title="Проверки через облако"
          note="Кадр уходит на распознавание. Чем реже интервал, тем дешевле. Если сцена не изменилась, обращения не будет."
        >
          {cloud.map(c => <Row key={c.id} check={c} saving={saving === c.id} onPatch={patch} />)}
        </Section>
      </div>
    </DashboardLayout>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-6 pt-5 pb-3">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="text-sm text-slate-400 mt-0.5">{note}</p>
      </div>
      <div className="divide-y divide-surface-300">{children}</div>
    </Card>
  );
}

function Row({
  check, saving, onPatch,
}: { check: Check; saving: boolean; onPatch: (id: string, f: Partial<Check>) => void }) {
  const minutes = check.threshold_sec ? Math.round(check.threshold_sec / 60) : null;

  return (
    <div className={`flex flex-wrap items-center gap-4 px-6 py-4 ${check.enabled ? '' : 'opacity-50'}`}>
      <button
        onClick={() => onPatch(check.id, { enabled: !check.enabled })}
        disabled={saving}
        aria-label={check.enabled ? 'Выключить пункт' : 'Включить пункт'}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
          check.enabled ? 'bg-success' : 'bg-surface-300'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
            check.enabled ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-slate-500 text-sm font-mono">{check.code}</span>
          <span className="text-white">{check.title}</span>
        </div>
        <div className="text-sm text-slate-400 mt-0.5">
          {check.zone_label}
          {minutes !== null && ` · норматив ${minutes} мин`}
        </div>
        {check.prompt_hint && (
          <div className="text-sm text-slate-500 mt-1 leading-relaxed">{check.prompt_hint}</div>
        )}
      </div>

      <div className="shrink-0">
        {check.mode === 'continuous' ? (
          <span className="text-sm text-slate-400">непрерывно</span>
        ) : (
          <select
            value={check.interval_min}
            disabled={saving}
            onChange={e => onPatch(check.id, { interval_min: Number(e.target.value) })}
            className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-1.5 text-white text-sm"
          >
            {INTERVALS.map(m => <option key={m} value={m}>раз в {m} мин</option>)}
          </select>
        )}
      </div>
    </div>
  );
}
