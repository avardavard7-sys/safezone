'use client';
import { useCallback, useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SeverityBadge, TypeBadge } from '@/components/ui/Badge';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, Check, X, RefreshCw, Image as ImageIcon, ShieldCheck, ShieldX, HelpCircle, Percent } from 'lucide-react';

type Verdict = 'confirmed' | 'false_alarm' | null;
type EventRow = {
  id: string; type: string; severity: string; description: string;
  camera_name: string | null; zone: string | null; floor: number | null; created_at: string;
  verdict: Verdict; review_note: string | null; resolved_at: string | null; resolved_by: string | null;
  image_url: string | null;
};
type Quality = {
  days: number; total: number; confirmed: number; false_alarm: number; unreviewed: number;
  false_rate: number | null;
  by_camera: { camera: string; total: number; confirmed: number; false_alarm: number; false_per_day: number }[];
};

const COLUMNS = 'id,type,severity,description,camera_name,zone,floor,created_at,verdict,review_note,resolved_at,resolved_by,image_url';
const VERDICT_TABS: { key: 'all' | 'pending' | 'confirmed' | 'false_alarm'; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'pending', label: 'Не проверены' },
  { key: 'confirmed', label: 'Подтверждённые' },
  { key: 'false_alarm', label: 'Ложные' },
];

export default function EventsPage() {
  const { mall } = useAuth();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [quality, setQuality] = useState<Quality | null>(null);
  const [severity, setSeverity] = useState('all');
  const [verdictTab, setVerdictTab] = useState<'all' | 'pending' | 'confirmed' | 'false_alarm'>('all');
  const [shots, setShots] = useState<Record<string, string | null>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<{ id: string; verdict: 'confirmed' | 'false_alarm' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!mall) return;
    const sb = createClient();
    let q = sb.from('events').select(COLUMNS).eq('mall_id', mall.id).order('created_at', { ascending: false }).limit(100);
    if (severity !== 'all') q = q.eq('severity', severity);
    if (verdictTab === 'pending') q = q.is('verdict', null);
    else if (verdictTab !== 'all') q = q.eq('verdict', verdictTab);
    const [{ data, error }, qa] = await Promise.all([q, sb.rpc('alarm_quality', { days: 7 })]);
    if (error) { setError(error.message); return; }
    const rows = (data as unknown as EventRow[]) || [];
    setEvents(rows);
    if (!qa.error) setQuality(qa.data as Quality);
    const ids = [...new Set(rows.map(r => r.resolved_by).filter(Boolean))] as string[];
    if (ids.length) {
      const { data: p } = await sb.from('profiles').select('id, username, full_name').in('id', ids);
      setNames(Object.fromEntries((p || []).map((x: any) => [x.id, x.full_name || x.username])));
    }
  }, [mall, severity, verdictTab]);

  useEffect(() => { load(); }, [load]);

  async function toggleShot(e: EventRow) {
    if (open === e.id) { setOpen(null); return; }
    setOpen(e.id);
    if (shots[e.id] !== undefined || e.image_url) return;
    const { data } = await createClient().from('events').select('screenshot_base64').eq('id', e.id).single();
    setShots(s => ({ ...s, [e.id]: data?.screenshot_base64 || null }));
  }

  async function review(id: string, verdict: 'confirmed' | 'false_alarm', text?: string) {
    setBusy(id); setError(null);
    const { error } = await createClient().rpc('review_event', { event_id: id, verdict, note: text || null });
    setBusy(null);
    if (error) { setError(error.message); return; }
    setNoteFor(null); setNote('');
    load();
  }

  const pct = quality?.false_rate != null ? Math.round(quality.false_rate * 100) : null;
  const noisy = (quality?.by_camera || []).filter(c => c.false_alarm > 0).slice(0, 3);

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Инциденты</h1>
          <p className="text-slate-400 text-sm">
            Отмечайте каждую тревогу: так видно, насколько системе можно доверять и где её подстроить.
          </p>
        </div>
        <Button variant="ghost" onClick={load}><RefreshCw size={16} />Обновить</Button>
      </div>

      {quality && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <StatCard title="Подтверждено за 7 дней" value={quality.confirmed} icon={<ShieldCheck size={18} />} color="success" />
          <StatCard title="Ложных" value={quality.false_alarm} icon={<ShieldX size={18} />} />
          <StatCard title="Не проверено" value={quality.unreviewed} icon={<HelpCircle size={18} />} color="accent" />
          <StatCard title="Доля ложных" value={pct === null ? '—' : `${pct}%`}
            subtitle={pct === null ? 'отметьте тревоги, чтобы посчитать' : 'среди проверенных'} icon={<Percent size={18} />} />
        </div>
      )}

      {noisy.length > 0 && (
        <Card className="!p-4 mb-4">
          <div className="text-sm text-slate-400 mb-2">Больше всего ложных тревог — эти камеры стоит подстроить:</div>
          <div className="flex flex-wrap gap-2">
            {noisy.map(c => (
              <span key={c.camera} className="px-3 py-1 rounded-lg bg-surface-200 text-sm text-white">
                {c.camera} — {c.false_alarm} из {c.total} · {c.false_per_day}/день
              </span>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex gap-1.5">
          {VERDICT_TABS.map(t => (
            <button key={t.key} onClick={() => setVerdictTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${verdictTab === t.key ? 'bg-primary text-white' : 'bg-surface-200 text-slate-400 hover:bg-surface-300'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {['all', 'critical', 'high', 'medium', 'low'].map(f => (
            <button key={f} onClick={() => setSeverity(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${severity === f ? 'bg-surface-300 text-white' : 'bg-surface-200 text-slate-500 hover:bg-surface-300'}`}>
              {f === 'all' ? 'Все уровни' : f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error && <Card className="!p-4 mb-4 border border-danger/40 text-red-400">{error}</Card>}

      <div className="space-y-3">
        {events.map(e => {
          const shot = e.image_url || (shots[e.id] ? `data:image/jpeg;base64,${shots[e.id]}` : null);
          return (
            <Card key={e.id} className="!p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <TypeBadge type={e.type} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white">{e.description}</p>
                    <p className="text-xs text-slate-500">
                      {e.camera_name || e.zone || 'Неизвестно'} • Этаж {e.floor || '—'} • {formatDate(e.created_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <SeverityBadge severity={e.severity} />
                  <button onClick={() => toggleShot(e)} className="p-1.5 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300" title="Снимок">
                    <ImageIcon size={14} />
                  </button>
                  {e.verdict === 'confirmed' && <span className="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30">Подтверждена</span>}
                  {e.verdict === 'false_alarm' && <span className="px-2 py-1 rounded-lg text-xs bg-slate-500/20 text-slate-300 border border-slate-500/30">Ложная</span>}
                  <button disabled={busy === e.id} onClick={() => { setNoteFor({ id: e.id, verdict: 'confirmed' }); setNote(''); }}
                    className={`p-1.5 rounded-lg hover:bg-green-500/30 ${e.verdict === 'confirmed' ? 'bg-green-500/30 text-green-300' : 'bg-green-500/15 text-green-400'}`} title="Подтвердить">
                    <Check size={14} />
                  </button>
                  <button disabled={busy === e.id} onClick={() => { setNoteFor({ id: e.id, verdict: 'false_alarm' }); setNote(''); }}
                    className={`p-1.5 rounded-lg hover:bg-slate-500/30 ${e.verdict === 'false_alarm' ? 'bg-slate-500/30 text-slate-200' : 'bg-slate-500/15 text-slate-400'}`} title="Ложная тревога">
                    <X size={14} />
                  </button>
                </div>
              </div>

              {e.verdict && (
                <p className="text-xs text-slate-500 mt-2">
                  Проверил: {(e.resolved_by && names[e.resolved_by]) || 'сотрудник'}
                  {e.resolved_at && ` · ${formatDate(e.resolved_at)}`}
                  {e.review_note && ` · «${e.review_note}»`}
                </p>
              )}

              {noteFor?.id === e.id && (
                <div className="mt-3 flex flex-wrap gap-2 items-center">
                  <input value={note} onChange={ev => setNote(ev.target.value)} autoFocus
                    placeholder={noteFor.verdict === 'confirmed' ? 'Что произошло, что сделали (необязательно)' : 'Что было на самом деле (необязательно)'}
                    className="flex-1 min-w-[16rem] bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-sm text-white" />
                  <button disabled={busy === e.id} onClick={() => review(e.id, noteFor.verdict, note)}
                    className={`px-4 py-2 rounded-lg text-sm text-white ${noteFor.verdict === 'confirmed' ? 'bg-green-600' : 'bg-slate-600'}`}>
                    {noteFor.verdict === 'confirmed' ? 'Подтвердить' : 'Отметить ложной'}
                  </button>
                  <button onClick={() => setNoteFor(null)} className="px-3 py-2 text-sm text-slate-400">Отмена</button>
                </div>
              )}

              {open === e.id && (
                <div className="mt-3">
                  {shot ? <img src={shot} alt="снимок события" className="max-h-96 rounded-lg" />
                    : <p className="text-sm text-slate-500">{shots[e.id] === undefined ? 'Загружаю снимок…' : 'Снимка нет'}</p>}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {events.length === 0 && (
        <Card className="text-center py-12">
          <AlertTriangle className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">Инцидентов нет</p>
        </Card>
      )}
    </DashboardLayout>
  );
}
