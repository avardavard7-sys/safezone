'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, StatCard } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { useObjectProfile } from '@/lib/object-profile';
import { Clock, Flame, ShoppingCart, Users } from 'lucide-react';

type Stats = { avg_dwell_min: number | null; sales: number | null; conversion: number | null };
type QueueNow = { region: string; people: number; at: string; max: number };
type Cam = { id: string; name: string; last_frame_base64: string | null };

// холодный лёд → тёплый янтарь → красный: чем больше людей бывало в клетке, тем горячее
function heatColor(v: number) {
  const stops = [[150, 215, 255], [51, 85, 242], [245, 158, 11], [239, 68, 68]];
  const x = Math.min(0.999, Math.max(0, v)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i, a = stops[i], b = stops[i + 1];
  return `rgba(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')},${(0.15 + 0.6 * v).toFixed(2)})`;
}

export default function ShopInsights({ stats }: { stats: Stats | null }) {
  const sb = createClient();
  const { has } = useObjectProfile();
  const [queues, setQueues] = useState<QueueNow[]>([]);
  const [cams, setCams] = useState<Cam[]>([]);
  const [cam, setCam] = useState('');
  const [days, setDays] = useState(1);
  const [grid, setGrid] = useState<{ cells: number[]; samples: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (has('queue')) {
      (async () => {
        const since = new Date(); since.setHours(0, 0, 0, 0);
        const [{ data: rows }, { data: regs }] = await Promise.all([
          sb.from('queue_samples').select('region_id, people, at').gte('at', since.toISOString()).order('at', { ascending: false }).limit(2000),
          sb.from('camera_regions').select('id, name').eq('kind', 'queue'),
        ]);
        const names = new Map((regs || []).map((r: any) => [r.id, r.name]));
        const by = new Map<string, QueueNow>();
        for (const r of (rows || []) as any[]) {
          const q = by.get(r.region_id);
          if (!q) by.set(r.region_id, { region: names.get(r.region_id) || 'Очередь', people: r.people, at: r.at, max: r.people });
          else q.max = Math.max(q.max, r.people);
        }
        setQueues([...by.values()]);
      })();
    }
    if (has('heatmap')) {
      sb.from('cameras').select('id, name, last_frame_base64').eq('is_active', true).order('name')
        .then(({ data }) => { const list = (data as Cam[]) || []; setCams(list); if (list[0]) setCam(list[0].id); });
    }
  }, [has('queue'), has('heatmap')]);

  useEffect(() => {
    if (!cam) return;
    sb.rpc('heatmap_grid', { p_camera: cam, p_days: days }).then(({ data }) => setGrid(data as any));
  }, [cam, days]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !grid) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    const max = Math.max(1, ...grid.cells);
    const cw = c.width / 32, ch = c.height / 18;
    grid.cells.forEach((v, i) => {
      if (!v) return;
      ctx.fillStyle = heatColor(Math.sqrt(v / max));
      ctx.fillRect((i % 32) * cw, Math.floor(i / 32) * ch, cw + 0.5, ch + 0.5);
    });
  }, [grid]);

  const frame = cams.find(c => c.id === cam)?.last_frame_base64;
  const showSales = has('conversion') && (stats?.sales ?? 0) > 0;

  return (
    <div className="space-y-6">
      {(has('dwell_time') || showSales || queues.length > 0) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {has('dwell_time') && (
            <StatCard title="Время в зале" value={stats?.avg_dwell_min != null ? `${stats.avg_dwell_min} мин` : '—'}
              subtitle="в среднем на посетителя" icon={<Clock size={18} />} color="primary" />
          )}
          {showSales && (
            <StatCard title="Конверсия" value={stats?.conversion != null ? `${Math.round(stats.conversion * 100)}%` : '—'}
              subtitle={`${stats?.sales} чеков`} icon={<ShoppingCart size={18} />} color="success" />
          )}
          {queues.map(q => (
            <StatCard key={q.region} title={`Очередь · ${q.region}`} value={`${q.people} чел.`}
              subtitle={`максимум сегодня ${q.max} · ${new Date(q.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' })}`}
              icon={<Users size={18} />} color={q.people >= 5 ? 'danger' : 'accent'} />
          ))}
        </div>
      )}

      {has('heatmap') && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Flame size={18} className="text-ice" /> Тепловая карта</h2>
            <select value={cam} onChange={e => setCam(e.target.value)} className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-1.5 text-sm text-white">
              {cams.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="flex gap-1">
              {[1, 7, 30].map(d => (
                <button key={d} onClick={() => setDays(d)}
                  className={`px-3 py-1.5 rounded-lg text-xs ${days === d ? 'bg-primary text-white' : 'bg-surface-200 text-slate-400'}`}>
                  {d === 1 ? 'Сутки' : d === 7 ? 'Неделя' : 'Месяц'}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate-500 ml-auto">{grid ? `замеров: ${grid.samples}` : ''}</span>
          </div>
          <div className="relative max-w-3xl aspect-video rounded-xl overflow-hidden bg-black">
            {frame && <img src={`data:image/jpeg;base64,${frame}`} alt="кадр камеры" className="absolute inset-0 w-full h-full object-cover opacity-70" />}
            <canvas ref={canvasRef} width={640} height={360} className="absolute inset-0 w-full h-full" />
            {grid && grid.samples === 0 && <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-sm">Данные появятся, когда бридж поработает с этой камерой</div>}
          </div>
          <p className="text-xs text-slate-500">Где чаще всего стоят и проходят люди: от ледяного — редко, до красного — постоянно.</p>
        </Card>
      )}
    </div>
  );
}
