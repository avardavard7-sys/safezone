'use client';

import { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Building2, Coffee, Factory, ShoppingBag, ShieldAlert, Lock } from 'lucide-react';
import {
  BUSINESS_TYPES, CATEGORY_LABEL, BLACKLIST_ACK,
  type BusinessType, type FeatureCategory, type FeatureInfo,
} from '@/lib/business';
import { loadFeatureCatalog, setBusinessType, setFeature, useObjectProfile } from '@/lib/object-profile';

const TYPE_ICON: Record<BusinessType, typeof ShoppingBag> = {
  shop: ShoppingBag, mall: Building2, cafe: Coffee, production: Factory,
};
const CATEGORY_ORDER: FeatureCategory[] = ['visitors', 'danger', 'theft', 'security', 'service'];

export default function BusinessProfilePage() {
  const { profile, loading } = useObjectProfile();
  const [catalog, setCatalog] = useState<FeatureInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<FeatureInfo | null>(null);
  const [ackChecked, setAckChecked] = useState(false);

  useEffect(() => { loadFeatureCatalog().then(setCatalog).catch(e => setError(e.message)); }, []);

  const grouped = useMemo(() => {
    const g = new Map<FeatureCategory, FeatureInfo[]>();
    for (const f of catalog) g.set(f.category, [...(g.get(f.category) || []), f]);
    return g;
  }, [catalog]);

  const canManage = Boolean(profile?.can_manage);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null);
    try { await fn(); } catch (e: any) { setError(e.message || 'Не получилось сохранить'); }
    finally { setBusy(null); }
  }

  function changeType(t: BusinessType) {
    if (!profile || t === profile.business_type) return;
    if (!confirm('Сменить тип объекта? Ручные настройки функций сбросятся на набор нового типа.')) return;
    run('type', () => setBusinessType(t));
  }

  function toggle(f: FeatureInfo) {
    const on = Boolean(profile?.features[f.key]);
    if (!on && f.sensitive) { setAckChecked(false); setAckFor(f); return; }
    run(f.key, () => setFeature(f.key, !on));
  }

  if (loading || !profile) {
    return <DashboardLayout><div className="text-slate-400">Загружаю профиль объекта…</div></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold font-display text-white">Профиль объекта</h1>
          <p className="text-slate-400 mt-1">
            Тип бизнеса определяет набор функций. Любую функцию можно включить или выключить
            отдельно — бридж подхватит изменения за несколько секунд.
          </p>
          {!canManage && (
            <p className="text-amber-300 text-sm mt-2 flex items-center gap-2">
              <Lock size={14} /> Менять профиль может только администратор объекта.
            </p>
          )}
        </div>

        {error && <div className="glass-card p-4 border border-danger/40 text-red-400">{error}</div>}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {BUSINESS_TYPES.map(t => {
            const Icon = TYPE_ICON[t.key];
            const active = profile.business_type === t.key;
            return (
              <button
                key={t.key}
                disabled={!canManage || busy === 'type'}
                onClick={() => changeType(t.key)}
                className={`glass-card p-5 text-left transition-all ${active ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/40'} disabled:cursor-not-allowed`}
              >
                <Icon className={active ? 'text-primary' : 'text-slate-400'} size={26} />
                <div className="text-white font-semibold mt-3">{t.label}</div>
                <div className="text-sm text-slate-400 mt-1">{t.hint}</div>
              </button>
            );
          })}
        </div>

        {CATEGORY_ORDER.filter(c => grouped.has(c)).map(cat => (
          <Card key={cat} className="p-0 overflow-hidden">
            <div className="px-6 pt-5 pb-3">
              <h2 className="text-lg font-semibold text-white">{CATEGORY_LABEL[cat]}</h2>
            </div>
            <div className="divide-y divide-surface-300">
              {grouped.get(cat)!.map(f => {
                const on = Boolean(profile.features[f.key]);
                return (
                  <div key={f.key} className={`flex items-center gap-4 px-6 py-4 ${on ? '' : 'opacity-60'}`}>
                    <Switch
                      checked={on}
                      onChange={() => toggle(f)}
                      disabled={!canManage || busy === f.key}
                      label={on ? `Выключить «${f.label}»` : `Включить «${f.label}»`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white">{f.label}</span>
                        {f.sensitive && <ShieldAlert size={15} className="text-amber-400" />}
                        {f.status === 'building' && (
                          <span className="text-xs px-2 py-0.5 rounded bg-primary/15 text-primary-light border border-primary/30">в разработке</span>
                        )}
                      </div>
                      <div className="text-sm text-slate-400 mt-0.5">{f.description}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {ackFor && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setAckFor(null)}>
          <div className="glass-card max-w-lg w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-white text-lg font-semibold">
              <ShieldAlert className="text-amber-400" /> {ackFor.label}
            </div>
            <ul className="text-sm text-slate-300 space-y-1.5 list-disc pl-5">
              <li>Сохраняются только лица, добавленные в список. Лица остальных посетителей сравниваются в памяти и сразу удаляются.</li>
              <li>Система сообщает о <b>возможном совпадении</b>, а не обвиняет. Решение принимает человек.</li>
              <li>У каждой записи — причина, автор и срок хранения.</li>
            </ul>
            <label className="flex gap-3 items-start text-sm text-slate-300 cursor-pointer">
              <input type="checkbox" checked={ackChecked} onChange={e => setAckChecked(e.target.checked)} className="mt-1" />
              <span>{BLACKLIST_ACK}</span>
            </label>
            <div className="flex justify-end gap-3">
              <button onClick={() => setAckFor(null)} className="px-4 py-2 rounded-lg text-slate-300 hover:bg-surface-200">Отмена</button>
              <button
                disabled={!ackChecked || busy === ackFor.key}
                onClick={() => { const f = ackFor; setAckFor(null); run(f.key, () => setFeature(f.key, true, BLACKLIST_ACK)); }}
                className="px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40"
              >
                Подтверждаю и включаю
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
