'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, StatCard } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { useObjectProfile } from '@/lib/object-profile';
import { Users, LogIn, LogOut, TrendingUp, Trash2, ArrowLeftRight } from 'lucide-react';
import ShopInsights from '@/components/visitors/ShopInsights';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type HourRow = { hour: string; entries: number; exits: number; inside: number };
type DayStats = {
  day_start: string;
  entries: number;
  exits: number;
  inside_now: number | null;
  peak: { count: number; at: string } | null;
  hours: HourRow[];
  avg_dwell_min: number | null;
  sales: number | null;
  conversion: number | null;
};
type CountLine = { id: string; camera_id: string; name: string; x1: number; y1: number; x2: number; y2: number; inside: 'left' | 'right'; enabled: boolean };
type Cam = { id: string; name: string };
type Pt = { x: number; y: number };

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' });

function insideArrow(l: { x1: number; y1: number; x2: number; y2: number; inside: 'left' | 'right' }) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len = Math.hypot(dx, dy) || 1;
  const s = l.inside === 'left' ? 1 : -1;
  const nx = (-dy / len) * s, ny = (dx / len) * s;
  const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
  return { mx, my, tx: mx + nx * 0.1, ty: my + ny * 0.1 };
}

function LineOverlay({ line, color }: { line: { x1: number; y1: number; x2: number; y2: number; inside: 'left' | 'right' }; color: string }) {
  const a = insideArrow(line);
  return (
    <g>
      <line x1={line.x1 * 100} y1={line.y1 * 100} x2={line.x2 * 100} y2={line.y2 * 100} stroke={color} strokeWidth="0.8" />
      <line x1={a.mx * 100} y1={a.my * 100} x2={a.tx * 100} y2={a.ty * 100} stroke="#10B981" strokeWidth="0.8" markerEnd="url(#arrow)" />
      <text x={a.tx * 100} y={a.ty * 100 + 3.5} fill="#10B981" fontSize="3" textAnchor="middle">внутрь</text>
    </g>
  );
}

export default function VisitorsPage() {
  const { profile, has } = useObjectProfile();
  const sb = createClient();
  const [stats, setStats] = useState<DayStats | null>(null);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [cams, setCams] = useState<Cam[]>([]);
  const [askAt, setAskAt] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editCam, setEditCam] = useState('');
  const [frame, setFrame] = useState<string | null>(null);
  const [pts, setPts] = useState<Pt[]>([]);
  const [inside, setInside] = useState<'left' | 'right'>('left');
  const [lineName, setLineName] = useState('Вход');
  const imgRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [s, l, c] = await Promise.all([
      sb.rpc('visitor_day_stats'),
      sb.from('count_lines').select('*').order('created_at'),
      sb.from('cameras').select('id, name').eq('is_active', true).order('name'),
    ]);
    if (s.error) setError(s.error.message); else setStats(s.data as DayStats);
    setLines((l.data as CountLine[]) || []);
    setCams((c.data as Cam[]) || []);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setFrame(null); setPts([]);
    if (!editCam) return;
    sb.from('cameras').select('last_frame_base64').eq('id', editCam).single()
      .then(({ data }) => setFrame(data?.last_frame_base64 || null));
  }, [editCam]);

  async function ask() {
    if (!askAt) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
    const ts = new Date(`${today}T${askAt}:00+05:00`).toISOString();
    const { data, error } = await sb.rpc('visitor_occupancy_at', { ts });
    setAnswer(error ? error.message : `В ${askAt} внутри было ${data} чел.`);
  }

  function clickFrame(e: React.MouseEvent) {
    if (!imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    setPts(prev => (prev.length >= 2 ? [p] : [...prev, p]));
  }

  async function saveLine() {
    if (pts.length !== 2 || !profile) return;
    const [a, b] = pts;
    const { error } = await sb.from('count_lines').insert({
      mall_id: profile.mall_id, camera_id: editCam, name: lineName || 'Вход',
      x1: +a.x.toFixed(4), y1: +a.y.toFixed(4), x2: +b.x.toFixed(4), y2: +b.y.toFixed(4), inside,
    });
    if (error) { setError(error.message); return; }
    setPts([]); setEditCam(''); load();
  }

  async function removeLine(id: string) {
    if (!confirm('Удалить линию подсчёта? Уже посчитанные посетители останутся.')) return;
    const { error } = await sb.from('count_lines').delete().eq('id', id);
    if (error) setError(error.message); else load();
  }

  if (profile && !has('visitor_count')) {
    return (
      <DashboardLayout>
        <div className="glass-card p-6 text-slate-300">
          Подсчёт посетителей выключен для этого объекта. Включить можно в «Профиле объекта».
        </div>
      </DashboardLayout>
    );
  }

  const camName = (id: string) => cams.find(c => c.id === id)?.name || 'камера';
  const draft = pts.length === 2 ? { x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, inside } : null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold font-display text-white">Посетители</h1>
          <p className="text-slate-400 mt-1">
            Считаются пересечения линии на входе. Лица не распознаются и не сохраняются.
            День считается от начала рабочего времени объекта.
          </p>
        </div>

        {error && <div className="glass-card p-4 border border-danger/40 text-red-400">{error}</div>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Сейчас внутри" value={stats?.inside_now ?? '—'} icon={<Users size={18} />} color="primary" />
          <StatCard title="Вошло сегодня" value={stats?.entries ?? 0} icon={<LogIn size={18} />} color="success" />
          <StatCard title="Вышло" value={stats?.exits ?? 0} icon={<LogOut size={18} />} />
          <StatCard
            title="Пик"
            value={stats?.peak ? stats.peak.count : '—'}
            subtitle={stats?.peak ? `в ${time(stats.peak.at)}` : 'пока нет данных'}
            icon={<TrendingUp size={18} />}
            color="accent"
          />
        </div>

        <ShopInsights stats={stats} />

        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="text-sm text-slate-400 mb-1">Сколько людей было внутри в</div>
              <input type="time" value={askAt} onChange={e => setAskAt(e.target.value)}
                className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white" />
            </div>
            <button onClick={ask} disabled={!askAt} className="px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40">
              Посчитать
            </button>
            {answer && <div className="text-white text-lg ml-2">{answer}</div>}
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-white mb-4">Сегодня по часам</h2>
          {stats && stats.hours.length ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={stats.hours}>
                  <CartesianGrid stroke="#22326c" strokeDasharray="3 3" />
                  <XAxis dataKey="hour" stroke="#64748b" fontSize={12} />
                  <YAxis stroke="#64748b" fontSize={12} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: '#0b1238', border: '1px solid #22326c', borderRadius: 8 }} />
                  <Legend />
                  <Bar dataKey="entries" name="Вошло" fill="#10B981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="exits" name="Вышло" fill="#64748b" radius={[4, 4, 0, 0]} />
                  <Line dataKey="inside" name="Внутри" stroke="#3355f2" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="text-slate-400">Данных за сегодня пока нет.</div>
          )}
        </Card>

        <Card className="space-y-4">
          <h2 className="text-lg font-semibold text-white">Линии подсчёта</h2>

          {lines.length === 0 && (
            <p className="text-slate-400 text-sm">Линий нет — подсчёт не идёт. Нарисуйте линию на кадре камеры, которая смотрит на вход.</p>
          )}
          {lines.map(l => (
            <div key={l.id} className="flex items-center gap-3 text-sm">
              <ArrowLeftRight size={16} className="text-primary" />
              <span className="text-white">{l.name}</span>
              <span className="text-slate-400">· {camName(l.camera_id)}</span>
              {profile?.can_manage && (
                <button onClick={() => removeLine(l.id)} className="ml-auto text-slate-400 hover:text-red-400" aria-label="Удалить линию">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}

          {profile?.can_manage && (
            <div className="border-t border-surface-300 pt-4 space-y-3">
              <div className="flex flex-wrap gap-3">
                <select value={editCam} onChange={e => setEditCam(e.target.value)}
                  className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white">
                  <option value="">Камера на входе…</option>
                  {cams.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input value={lineName} onChange={e => setLineName(e.target.value)} placeholder="Название"
                  className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white" />
              </div>

              {editCam && (
                frame ? (
                  <>
                    <p className="text-sm text-slate-400">
                      Кликните две точки поперёк прохода — по порогу двери. Зелёная стрелка показывает, где «внутри».
                    </p>
                    <div ref={imgRef} onClick={clickFrame} className="relative max-w-3xl cursor-crosshair select-none">
                      <img src={`data:image/jpeg;base64,${frame}`} alt="кадр камеры" className="w-full rounded-lg" draggable={false} />
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
                        <defs>
                          <marker id="arrow" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">
                            <path d="M0,0 L4,2 L0,4 z" fill="#10B981" />
                          </marker>
                        </defs>
                        {lines.filter(l => l.camera_id === editCam).map(l => <LineOverlay key={l.id} line={l} color="#64748b" />)}
                        {pts.map((p, i) => <circle key={i} cx={p.x * 100} cy={p.y * 100} r="1" fill="#F59E0B" />)}
                        {draft && <LineOverlay line={draft} color="#F59E0B" />}
                      </svg>
                    </div>
                    <div className="flex gap-3">
                      <button disabled={!draft} onClick={() => setInside(v => (v === 'left' ? 'right' : 'left'))}
                        className="px-4 py-2 rounded-lg bg-surface-200 text-white disabled:opacity-40">
                        Поменять «внутри»
                      </button>
                      <button disabled={!draft} onClick={saveLine} className="px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40">
                        Сохранить линию
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-amber-300">У камеры ещё нет кадра — дождитесь, пока бридж его пришлёт.</p>
                )
              )}
            </div>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}
