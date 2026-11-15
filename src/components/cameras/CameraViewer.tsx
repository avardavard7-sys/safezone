'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useObjectProfile } from '@/lib/object-profile';
import { useOverlayTracks } from '@/lib/live-overlay';
import { frameRect, insideNormal, toFrame, toScreen, type Rect } from '@/lib/video-geometry';
import LivePlayer, { type LiveState } from './LivePlayer';
import { Banknote, LogIn, LogOut, PenLine, ShoppingBag, Trash2, Users, X } from 'lucide-react';

type LineCount = {
  line_id: string; name: string;
  x1: number; y1: number; x2: number; y2: number; inside: 'left' | 'right';
  entries: number; exits: number;
};
type Pt = { x: number; y: number };
type RegionKind = 'shelf' | 'cash_drawer' | 'cash_customer' | 'queue';
type Region = { id: string; kind: RegionKind; name: string; points: [number, number][] };
const REGION_STYLE: Record<RegionKind, { color: string; title: string; hint: string }> = {
  shelf: { color: '#F59E0B', title: 'Полка', hint: 'Обведите полку кликами по углам' },
  cash_drawer: { color: '#EF4444', title: 'Денежный ящик', hint: 'Обведите денежный ящик кассы' },
  cash_customer: { color: '#60A5FA', title: 'Зона покупателя', hint: 'Обведите место, где стоит покупатель у кассы' },
  queue: { color: '#A78BFA', title: 'Зона очереди', hint: 'Обведите место, где люди стоят в очереди к кассе' },
};

const STALE_MS = 1500;
const FLASH_MS = 1200;

export default function CameraViewer({ cameraId, cameraName }: { cameraId: string; cameraName: string }) {
  const sb = createClient();
  const { profile, has } = useObjectProfile();
  const boxRef = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const [live, setLive] = useState<LiveState>('idle');
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [lines, setLines] = useState<LineCount[]>([]);
  const [insideNow, setInsideNow] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ lineId: string; dir: 'in' | 'out'; at: number } | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [pts, setPts] = useState<Pt[]>([]);
  const [inside, setInside] = useState<'left' | 'right'>('left');
  const [error, setError] = useState<string | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [drawKind, setDrawKind] = useState<RegionKind | null>(null);
  const [shelfPts, setShelfPts] = useState<Pt[]>([]);
  const [quiet, setQuiet] = useState('');
  const [, tick] = useState(0);

  const snapshotMode = live === 'unavailable';
  const boxesOn = has('people_boxes');
  const tracks = useOverlayTracks(profile?.mall_id, cameraId, boxesOn && !snapshotMode);

  const loadCounts = useCallback(async () => {
    const [c, s] = await Promise.all([
      sb.rpc('line_day_counts', { cam: cameraId }),
      sb.rpc('visitor_day_stats'),
    ]);
    if (!c.error) setLines((c.data as LineCount[]) || []);
    const r = await sb.from('camera_regions').select('id, kind, name, points').eq('camera_id', cameraId).eq('enabled', true);
    if (profile?.mall_id) {
      const mq = await sb.from('malls').select('cash_quiet_hours').eq('id', profile.mall_id).maybeSingle();
      const ranges = (mq.data?.cash_quiet_hours as { from: string; to: string }[]) || [];
      setQuiet(ranges.map(x => `${x.from}-${x.to}`).join(', '));
    }
    if (!r.error) setRegions((r.data as Region[]) || []);
    if (!s.error && s.data) setInsideNow((s.data as { inside_now: number | null }).inside_now);
  }, [cameraId]);

  useEffect(() => {
    loadCounts();
    sb.from('cameras').select('last_frame_base64').eq('id', cameraId).single()
      .then(({ data }) => setSnapshot(data?.last_frame_base64 || null));

    // «+1» сразу, как бридж записал проход
    const ch = sb.channel(`visits-${cameraId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'visitor_events', filter: `camera_id=eq.${cameraId}` },
        (p: any) => {
          const e = p.new as { line_id: string | null; direction: 'in' | 'out' };
          if (!e.line_id) return;
          setLines(ls => ls.map(l => l.line_id !== e.line_id ? l
            : { ...l, entries: l.entries + (e.direction === 'in' ? 1 : 0), exits: l.exits + (e.direction === 'out' ? 1 : 0) }));
          setInsideNow(n => (n === null ? n : Math.max(0, n + (e.direction === 'in' ? 1 : -1))));
          setFlash({ lineId: e.line_id, dir: e.direction, at: Date.now() });
        })
      .subscribe();
    const t = setInterval(loadCounts, 60000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
  }, [cameraId, loadCounts]);

  useEffect(() => {
    if (!boxRef.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ W: e.contentRect.width, H: e.contentRect.height }));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);

  // перерисовка для гашения устаревших рамок и вспышек
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 300); return () => clearInterval(t); }, []);

  const vw = snapshotMode ? img?.naturalWidth || 0 : video?.videoWidth || 0;
  const vh = snapshotMode ? img?.naturalHeight || 0 : video?.videoHeight || 0;
  const rect: Rect = frameRect(vw, vh, size.W, size.H, 'contain');
  const ready = rect.w > 0 && rect.h > 0 && vw > 0;

  const freshTracks = tracks && Date.now() - tracks.receivedAt < STALE_MS && live === 'live' ? tracks.tracks : [];
  const flashing = flash && Date.now() - flash.at < FLASH_MS ? flash : null;

  function click(e: React.MouseEvent) {
    if ((!drawing && !drawKind) || !boxRef.current || !ready) return;
    const b = boxRef.current.getBoundingClientRect();
    const p = toFrame(e.clientX - b.left, e.clientY - b.top, rect);
    if (!p) return;
    if (drawKind) { setShelfPts(prev => (prev.length >= 24 ? prev : [...prev, p])); return; }
    setPts(prev => (prev.length >= 2 ? [p] : [...prev, p]));
  }

  async function saveRegion() {
    if (shelfPts.length < 3 || !profile || !drawKind) return;
    const st = REGION_STYLE[drawKind];
    const same = regions.filter(r => r.kind === drawKind).length;
    const name = prompt(`Название: ${st.title.toLowerCase()}`, drawKind === 'cash_customer' ? 'У кассы' : `${st.title} ${same + 1}`) || st.title;
    const { error } = await sb.from('camera_regions').insert({
      mall_id: profile.mall_id, camera_id: cameraId, kind: drawKind, name,
      points: shelfPts.map(p => [+p.x.toFixed(4), +p.y.toFixed(4)]),
    });
    if (error) { setError(error.message); return; }
    setDrawKind(null); setShelfPts([]); loadCounts();
  }

  function startRegion(kind: RegionKind) { setDrawKind(kind); setShelfPts([]); setDrawing(false); setPts([]); }

  async function removeRegion(id: string) {
    if (!confirm('Удалить эту разметку?')) return;
    const { error } = await sb.from('camera_regions').delete().eq('id', id);
    if (error) setError(error.message); else loadCounts();
  }

  async function saveLine() {
    if (pts.length !== 2 || !profile) return;
    const [a, b] = pts;
    const { error } = await sb.from('count_lines').insert({
      mall_id: profile.mall_id, camera_id: cameraId, name: 'Вход',
      x1: +a.x.toFixed(4), y1: +a.y.toFixed(4), x2: +b.x.toFixed(4), y2: +b.y.toFixed(4), inside,
    });
    if (error) { setError(error.message); return; }
    setDrawing(false); setPts([]); loadCounts();
  }

  const draft = pts.length === 2 ? { x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, inside } : null;
  const S = (nx: number, ny: number) => toScreen(nx, ny, rect);

  function renderLine(l: { x1: number; y1: number; x2: number; y2: number; inside: 'left' | 'right' }, key: string, color: string, glow = false) {
    const a = S(l.x1, l.y1), b = S(l.x2, l.y2);
    const n = insideNormal(l);
    const m = S(n.mx, n.my);
    const t = { x: m.x + n.nx * 40, y: m.y + n.ny * 40 };
    return (
      <g key={key}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={glow ? 6 : 3}
          style={glow ? { filter: `drop-shadow(0 0 8px ${color})` } : undefined} />
        <line x1={m.x} y1={m.y} x2={t.x} y2={t.y} stroke="#10B981" strokeWidth={2} markerEnd="url(#cv-arrow)" />
      </g>
    );
  }

  const totalIn = lines.reduce((s, l) => s + l.entries, 0);
  const totalOut = lines.reduce((s, l) => s + l.exits, 0);

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div ref={boxRef} onClick={click}
        className={`relative flex-1 aspect-video bg-black rounded-xl overflow-hidden ${drawing || drawKind ? 'cursor-crosshair' : ''}`}>
        {snapshot && (
          <img ref={setImg} src={`data:image/jpeg;base64,${snapshot}`} alt={cameraName}
            className={`absolute inset-0 w-full h-full object-contain ${live === 'live' ? 'opacity-0' : 'opacity-100'}`} />
        )}
        {!snapshotMode && <LivePlayer cameraId={cameraId} fit="contain" onState={setLive} onVideo={setVideo} className="absolute inset-0" />}

        {ready && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" width={size.W} height={size.H}>
            <defs>
              <marker id="cv-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#10B981" />
              </marker>
            </defs>
            {regions.map(r => {
              const c = REGION_STYLE[r.kind]?.color || '#F59E0B';
              const ps = r.points.map(([x, y]) => S(x, y));
              const top = ps.reduce((a, b) => (b.y < a.y ? b : a), ps[0]);
              return (
                <g key={r.id}>
                  <polygon points={ps.map(p => `${p.x},${p.y}`).join(' ')} fill={c} fillOpacity={0.12} stroke={c} strokeWidth={2} strokeDasharray="6 4" />
                  <text x={top.x + 4} y={top.y + 16} fontSize="13" fontWeight="600" fill={c}>{r.name}</text>
                </g>
              );
            })}
            {shelfPts.length > 0 && (
              <polygon points={shelfPts.map(p => { const s = S(p.x, p.y); return `${s.x},${s.y}`; }).join(' ')}
                fill="rgba(99,102,241,0.15)" stroke="#3355f2" strokeWidth={2} />
            )}
            {shelfPts.map((p, i) => { const s = S(p.x, p.y); return <circle key={`sp${i}`} cx={s.x} cy={s.y} r={5} fill="#3355f2" />; })}
            {lines.map(l => renderLine(l, l.line_id, flashing?.lineId === l.line_id ? '#10B981' : '#F59E0B', flashing?.lineId === l.line_id))}
            {draft && renderLine(draft, 'draft', '#3355f2')}
            {pts.map((p, i) => { const s = S(p.x, p.y); return <circle key={i} cx={s.x} cy={s.y} r={6} fill="#3355f2" />; })}
            {freshTracks.map(tr => {
              const a = S(tr.b[0], tr.b[1]), b = S(tr.b[2], tr.b[3]);
              return (
                <g key={tr.id}>
                  <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke="#22D3EE" strokeWidth={2} rx={3} />
                  <rect x={a.x} y={a.y - 18} width={34} height={18} fill="#22D3EE" rx={3} />
                  <text x={a.x + 4} y={a.y - 5} fontSize="12" fontWeight="600" fill="#06081e">#{tr.id}</text>
                </g>
              );
            })}
            {flashing && (() => {
              const l = lines.find(x => x.line_id === flashing.lineId);
              if (!l) return null;
              const m = S((l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2);
              return <text x={m.x} y={m.y - 14} textAnchor="middle" fontSize="28" fontWeight="700"
                fill={flashing.dir === 'in' ? '#10B981' : '#94A3B8'}>{flashing.dir === 'in' ? '+1' : '−1'}</text>;
            })()}
          </svg>
        )}

        <div className="absolute top-2 left-2 px-2 py-1 rounded-full bg-black/60 text-xs font-medium text-white">
          {live === 'live' ? <span className="text-green-400">● LIVE</span>
            : snapshotMode ? <span className="text-slate-300">СНИМОК — рамки появятся в LIVE</span>
            : <span className="text-amber-300">подключение…</span>}
        </div>
      </div>

      <aside className="lg:w-64 space-y-3">
        <div className="glass-card p-4">
          <div className="text-sm text-slate-400 flex items-center gap-2"><Users size={15} /> Внутри объекта сейчас</div>
          <div className="text-4xl font-bold text-white mt-1">{insideNow ?? '—'}</div>
        </div>

        {lines.length > 0 && (
          <div className="glass-card p-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-slate-400 flex items-center gap-1"><LogIn size={13} /> Вошло</div>
              <div className="text-2xl font-semibold text-green-400">{totalIn}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 flex items-center gap-1"><LogOut size={13} /> Вышло</div>
              <div className="text-2xl font-semibold text-slate-300">{totalOut}</div>
            </div>
          </div>
        )}

        {lines.length > 1 && lines.map(l => (
          <div key={l.line_id} className="glass-card px-4 py-3 text-sm flex justify-between">
            <span className="text-white">{l.name}</span>
            <span className="text-slate-400">+{l.entries} / −{l.exits}</span>
          </div>
        ))}

        {lines.length === 0 && !drawing && (
          <div className="glass-card p-4 text-sm text-slate-400">На этой камере нет линии подсчёта.</div>
        )}

        {profile?.can_manage && has('visitor_count') && (
          !drawing ? (
            <button onClick={() => { setDrawing(true); setPts([]); setDrawKind(null); setShelfPts([]); }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-surface-200 text-white hover:bg-surface-300">
              <PenLine size={16} /> Нарисовать линию
            </button>
          ) : (
            <div className="glass-card p-4 space-y-3 text-sm">
              <p className="text-slate-300">Кликните две точки по полу на пороге. Зелёная стрелка — «внутрь».</p>
              <div className="flex gap-2">
                <button disabled={!draft} onClick={() => setInside(v => (v === 'left' ? 'right' : 'left'))}
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-200 text-white disabled:opacity-40">Развернуть</button>
                <button disabled={!draft} onClick={saveLine}
                  className="flex-1 px-3 py-2 rounded-lg bg-primary text-white disabled:opacity-40">Сохранить</button>
              </div>
              <button onClick={() => { setDrawing(false); setPts([]); }} className="w-full flex items-center justify-center gap-1 text-slate-400">
                <X size={14} /> Отмена
              </button>
            </div>
          )
        )}

        {(has('theft_shelf') || has('theft_cashier') || has('queue')) && (
          <div className="glass-card p-4 space-y-3 text-sm">
            {([
              ['shelf', has('theft_shelf'), <ShoppingBag key="i" size={15} />, 'Полки под наблюдением', 'Не размечено — кража с полки не отслеживается.'],
              ['cash_drawer', has('theft_cashier'), <Banknote key="i" size={15} />, 'Денежный ящик', 'Не размечен — касса не отслеживается.'],
              ['cash_customer', has('theft_cashier'), <Users key="i" size={15} />, 'Зона покупателя', 'Не размечена — правило «касса без покупателя» выключено.'],
              ['queue', has('queue'), <Users key="i" size={15} />, 'Зона очереди', 'Не размечена — очередь не считается.'],
            ] as [RegionKind, boolean, React.ReactNode, string, string][]).filter(([, on]) => on).map(([kind, , icon, title, empty]) => {
              const list = regions.filter(r => r.kind === kind);
              return (
                <div key={kind} className="space-y-1.5">
                  <div className="flex items-center gap-2" style={{ color: REGION_STYLE[kind].color }}>{icon} {title}</div>
                  {list.length === 0 && drawKind !== kind && <p className="text-slate-500">{empty}</p>}
                  {list.map(r => (
                    <div key={r.id} className="flex items-center justify-between">
                      <span className="text-white">{r.name}</span>
                      {profile?.can_manage && (
                        <button onClick={() => removeRegion(r.id)} className="text-slate-500 hover:text-red-400" aria-label="Удалить разметку"><Trash2 size={14} /></button>
                      )}
                    </div>
                  ))}
                  {profile?.can_manage && drawKind !== kind && (
                    <button onClick={() => startRegion(kind)} className="w-full px-3 py-1.5 rounded-lg bg-surface-200 text-white hover:bg-surface-300">Отметить</button>
                  )}
                  {drawKind === kind && (
                    <div className="space-y-2 pt-1">
                      <p className="text-slate-300">{REGION_STYLE[kind].hint} — от 3 точек. Сейчас: {shelfPts.length}.</p>
                      <div className="flex gap-2">
                        <button disabled={shelfPts.length < 3} onClick={saveRegion} className="flex-1 px-3 py-2 rounded-lg bg-primary text-white disabled:opacity-40">Готово</button>
                        <button onClick={() => { setDrawKind(null); setShelfPts([]); }} className="flex-1 px-3 py-2 rounded-lg bg-surface-200 text-slate-300">Отмена</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {has('theft_cashier') && profile?.can_manage && regions.some(r => r.kind === 'cash_drawer') && (
          <div className="glass-card p-4 space-y-2 text-sm">
            <div className="text-slate-300">Тихие часы кассы</div>
            <p className="text-xs text-slate-500">Инкассация и размен в эти промежутки не вызывают тревогу «касса без покупателя».</p>
            <input value={quiet} onChange={e => setQuiet(e.target.value)} placeholder="09:00-09:30, 21:45-22:00"
              onBlur={async () => {
                const { data, error: e } = await sb.rpc('set_cash_quiet_hours', { p_mall: profile.mall_id, p_ranges: quiet });
                if (e) { setError(e.message); return; }
                setError(null);
                setQuiet(((data as { from: string; to: string }[]) || []).map(x => `${x.from}-${x.to}`).join(', '));
              }}
              className="w-full bg-surface-200 border border-[rgba(150,215,255,0.2)] rounded-lg px-3 py-2 text-white" />
          </div>
        )}

        {error && <div className="glass-card p-3 text-sm text-red-400">{error}</div>}
      </aside>
    </div>
  );
}
