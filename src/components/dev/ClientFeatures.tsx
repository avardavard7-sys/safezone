'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Switch } from '@/components/ui/Switch';
import { BLACKLIST_ACK, BUSINESS_TYPES, CATEGORY_LABEL, type BusinessType, type FeatureCategory, type FeatureInfo } from '@/lib/business';
import { loadFeatureCatalog } from '@/lib/object-profile';
import { ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';

type Profile = { mall_id: string; name: string; business_type: BusinessType; features: Record<string, boolean> };
const ORDER: FeatureCategory[] = ['visitors', 'danger', 'theft', 'security', 'service'];

/** Профиль клиентского объекта: название, тип и функции — меняет только разработчик. */
export default function ClientFeatures({ mallId, onChanged }: { mallId: string; onChanged?: () => void }) {
  const sb = createClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [catalog, setCatalog] = useState<FeatureInfo[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<FeatureInfo | null>(null);
  const [ackChecked, setAckChecked] = useState(false);

  async function load() {
    const [{ data }, cat] = await Promise.all([sb.rpc('dev_object_profile', { p_mall: mallId }), loadFeatureCatalog()]);
    setProfile(data as Profile); setName((data as Profile)?.name || ''); setCatalog(cat);
  }
  useEffect(() => { load(); }, [mallId]);

  const grouped = useMemo(() => {
    const g = new Map<FeatureCategory, FeatureInfo[]>();
    for (const f of catalog) g.set(f.category, [...(g.get(f.category) || []), f]);
    return g;
  }, [catalog]);

  async function run(key: string, fn: () => PromiseLike<{ data: any; error: any }>) {
    setBusy(key);
    const { data, error } = await fn();
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    if (data && typeof data === 'object') setProfile(data as Profile);
    onChanged?.();
  }

  function toggle(f: FeatureInfo) {
    const on = Boolean(profile?.features[f.key]);
    if (!on && f.sensitive) { setAckChecked(false); setAckFor(f); return; }
    run(f.key, () => sb.rpc('dev_set_object_feature', { p_mall: mallId, feature_key: f.key, enabled: !on }));
  }

  if (!profile) return <div className="px-6 py-4 text-sm text-slate-400">Загружаю профиль объекта…</div>;

  return (
    <div className="px-6 py-4 space-y-4 bg-white/[0.02] border-t border-[rgba(150,215,255,0.1)]">
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={e => setName(e.target.value)}
          className="bg-surface-200 border border-[rgba(150,215,255,0.2)] rounded-lg px-3 py-1.5 text-sm text-white w-64" />
        <button disabled={busy === 'name' || name.trim() === profile.name}
          onClick={() => run('name', async () => { const r = await sb.rpc('dev_rename_object', { p_mall: mallId, p_name: name }); if (!r.error) { await load(); toast.success('Название сохранено'); } return { data: null, error: r.error }; })}
          className="px-3 py-1.5 rounded-lg bg-surface-200 text-sm text-white disabled:opacity-40">Переименовать</button>
        <select value={profile.business_type} disabled={busy === 'type'}
          onChange={e => {
            const t = e.target.value as BusinessType;
            if (!confirm('Сменить тип объекта? Ручные настройки функций сбросятся на набор нового типа.')) return;
            run('type', () => sb.rpc('dev_set_business_type', { p_mall: mallId, t }));
          }}
          className="bg-surface-200 border border-[rgba(150,215,255,0.2)] rounded-lg px-3 py-1.5 text-sm text-white ml-auto">
          {BUSINESS_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {ORDER.filter(c => grouped.has(c)).map(cat => (
          <div key={cat} className="space-y-1.5">
            <div className="text-xs font-semibold tracking-wider text-ice/80 uppercase">{CATEGORY_LABEL[cat]}</div>
            {grouped.get(cat)!.map(f => {
              const on = Boolean(profile.features[f.key]);
              return (
                <div key={f.key} className="flex items-center gap-3 text-sm">
                  <Switch checked={on} disabled={busy === f.key} onChange={() => toggle(f)} label={f.label} />
                  <span className={on ? 'text-white' : 'text-slate-400'}>{f.label}</span>
                  {f.sensitive && <ShieldAlert size={14} className="text-amber-400" />}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {ackFor && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setAckFor(null)}>
          <div className="glass-card max-w-lg w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-white text-lg font-semibold"><ShieldAlert className="text-amber-400" /> {ackFor.label} — {profile.name}</div>
            <p className="text-sm text-slate-300">Включайте, только если владелец объекта подтвердил вам это письменно.</p>
            <label className="flex gap-3 items-start text-sm text-slate-300 cursor-pointer">
              <input type="checkbox" checked={ackChecked} onChange={e => setAckChecked(e.target.checked)} className="mt-1" />
              <span>{BLACKLIST_ACK}</span>
            </label>
            <div className="flex justify-end gap-3">
              <button onClick={() => setAckFor(null)} className="px-4 py-2 rounded-lg text-slate-300">Отмена</button>
              <button disabled={!ackChecked}
                onClick={() => { const f = ackFor; setAckFor(null); run(f.key, () => sb.rpc('dev_set_object_feature', { p_mall: mallId, feature_key: f.key, enabled: true, ack_text: BLACKLIST_ACK })); }}
                className="px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40">Подтверждаю и включаю</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
