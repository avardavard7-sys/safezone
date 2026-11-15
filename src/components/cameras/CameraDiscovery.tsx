'use client';

/**
 * Автопоиск камер: панель кладёт команду в Supabase, бридж забирает её,
 * перебирает сеть объекта и отвечает списком камер — по одной на канал
 * регистратора. Добавляются разом, кнопкой.
 */

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Check, KeyRound, Loader2, Plus, ScanSearch, Trash2, TriangleAlert } from 'lucide-react';

const POLL_MS = 2000;
const TIMEOUT_MS = 200000;

type Stream = {
  host: string; ip: string; port: number; path: string; channel: number | null;
  name: string; resolution: string | null; encoding: string | null; browser_ok: boolean; cred: number;
};
type Cred = { user: string; pass: string };

const field = 'bg-surface-200 border border-[rgba(150,215,255,0.2)] rounded-lg px-3 py-2 text-white text-sm';

export function CameraDiscovery({ onAdded }: { onAdded?: () => void }) {
  const { mall, profile } = useAuth();
  const dev = profile?.role === 'developer';
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [open, setOpen] = useState(false);
  const [creds, setCreds] = useState<Cred[]>([{ user: 'admin', pass: '' }]);
  const [subnet, setSubnet] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [authFailed, setAuthFailed] = useState<{ host: string }[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<number | null>(null);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const key = (s: { ip: string; path: string }) => `${s.ip}|${s.path}`;

  async function runCommand(kind: 'discover', params: Record<string, unknown>) {
    const sb = createClient();
    const { data: { user: u } } = await sb.auth.getUser();
    if (!mall?.id || !u) throw new Error('не удалось определить объект — перезайдите в панель');
    const { data: cmd, error } = await sb.from('bridge_commands')
      .insert({ mall_id: mall.id, kind, params, created_by: u.id }).select('id').single();
    if (error) throw new Error(error.message);
    const started = Date.now();
    setStage('Команда отправлена, жду бридж…');
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise(r => timers.current.push(setTimeout(r, POLL_MS)));
      const { data: row } = await sb.from('bridge_commands').select('status,result,error').eq('id', cmd.id).maybeSingle();
      if (!row) continue;
      if (row.status === 'running') setStage('Ищу камеры в сети объекта — это займёт до минуты…');
      if (row.status === 'done') return row.result;
      if (row.status === 'error') throw new Error(row.error || 'бридж вернул ошибку');
    }
    throw new Error('бридж не ответил — проверьте, что коробка или бридж на объекте включены');
  }

  async function discover() {
    setBusy(true); setError(null); setStreams([]); setAuthFailed([]); setAdded(null);
    try {
      const sb = createClient();
      const { data: cams } = await sb.from('cameras').select('ip_address, rtsp_path').eq('mall_id', mall!.id);
      const have = new Set((cams || []).map((c: any) => key({ ip: c.ip_address, path: c.rtsp_path })));
      setExisting(have);

      const res: any = await runCommand('discover', {
        creds: creds.filter(c => c.user.trim()).map(c => ({ user: c.user.trim(), pass: c.pass })),
        subnet: dev ? subnet.trim() || null : null,
        multicast: true,
      });
      // старый бридж отвечает без группировки по каналам — показываем как есть
      const list: Stream[] = res?.streams || (res?.suggestions || []).map((s: any) => ({
        host: s.host, ip: s.ip, port: s.port, path: s.path, channel: null,
        name: `${s.manufacturer || 'Камера'} ${s.host}${s.is_substream ? ' (доп. поток)' : ''}`,
        resolution: s.resolution, encoding: null, browser_ok: true, cred: 0,
      }));
      setStreams(list);
      setAuthFailed(res?.auth_failed || []);
      setPicked(Object.fromEntries(list.map(s => [key(s), !have.has(key(s))])));
      if (!list.length && !(res?.auth_failed || []).length) setError('Камеры не найдены. Проверьте, что коробка подключена в сеть, где стоят камеры или регистратор.');
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); setStage(''); }
  }

  async function addPicked() {
    const rows = streams.filter(s => picked[key(s)] && !existing.has(key(s))).map(s => {
      const c = creds[s.cred] || creds[0];
      return {
        mall_id: mall!.id, name: s.name, ip_address: s.ip, port: s.port || 554,
        username: c.user.trim(), password: c.pass, rtsp_path: s.path,
        floor: 1, is_active: true, ai_enabled: true,
      };
    });
    if (!rows.length) return;
    setBusy(true); setError(null);
    const { error } = await createClient().from('cameras').insert(rows);
    setBusy(false);
    if (error) { setError(error.message); return; }
    setAdded(rows.length);
    setExisting(prev => new Set([...prev, ...rows.map(r => key({ ip: r.ip_address, path: r.rtsp_path }))]));
    onAdded?.();
  }

  const toAdd = streams.filter(s => picked[key(s)] && !existing.has(key(s))).length;

  return (
    <div className="glass-card p-5 mb-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-white font-semibold flex items-center gap-2"><ScanSearch size={18} className="text-ice" /> Автопоиск камер</div>
          <p className="text-sm text-slate-400 mt-0.5">Найдёт камеры и регистраторы в сети объекта и добавит их одной кнопкой.</p>
        </div>
        {!open && <button onClick={() => setOpen(true)} className="px-4 py-2 rounded-lg bg-primary text-white text-sm">Найти камеры</button>}
      </div>

      {open && (
        <>
          <div className="space-y-2">
            <div className="text-sm text-slate-300">Логин и пароль камер или регистратора</div>
            {creds.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <KeyRound size={15} className="text-slate-500" />
                <input className={`${field} w-40`} placeholder="Логин" value={c.user}
                  onChange={e => setCreds(cs => cs.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)))} />
                <input className={`${field} w-48`} placeholder="Пароль" type="password" value={c.pass}
                  onChange={e => setCreds(cs => cs.map((x, j) => (j === i ? { ...x, pass: e.target.value } : x)))} />
                {i > 0 && <button onClick={() => setCreds(cs => cs.filter((_, j) => j !== i))} className="text-slate-500 hover:text-red-400" aria-label="Убрать"><Trash2 size={15} /></button>}
              </div>
            ))}
            {creds.length < 4 && (
              <button onClick={() => setCreds(cs => [...cs, { user: 'admin', pass: '' }])} className="text-sm text-ice hover:underline flex items-center gap-1">
                <Plus size={14} /> Ещё логин и пароль — если у второго регистратора другой
              </button>
            )}
            {dev && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input className={`${field} w-56`} placeholder="Подсеть, например 192.168.1" value={subnet} onChange={e => setSubnet(e.target.value)} />
                <span className="text-xs text-slate-500">необязательно — по умолчанию сеть объекта</span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={discover} disabled={busy} className="px-4 py-2 rounded-lg bg-primary text-white text-sm disabled:opacity-50 flex items-center gap-2">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} {busy ? 'Ищу…' : 'Начать поиск'}
            </button>
            <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg bg-surface-200 text-slate-300 text-sm">Свернуть</button>
          </div>

          {stage && <div className="text-sm text-slate-300">{stage}</div>}
          {error && <div className="text-sm text-red-400">{error}</div>}

          {authFailed.length > 0 && (
            <div className="text-sm text-amber-300 flex gap-2">
              <TriangleAlert size={16} className="shrink-0 mt-0.5" />
              <span>Не приняли логин и пароль: {authFailed.map(a => a.host).join(', ')}. Добавьте их логин и пароль строкой выше и повторите поиск.</span>
            </div>
          )}

          {streams.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-slate-300">Найдено камер: {streams.length}</div>
              <div className="divide-y divide-[rgba(150,215,255,0.1)] rounded-xl border border-[rgba(150,215,255,0.14)] overflow-hidden">
                {streams.map(s => {
                  const k = key(s), have = existing.has(k);
                  return (
                    <label key={k} className={`flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm ${have ? 'opacity-50' : 'cursor-pointer hover:bg-white/5'}`}>
                      <input type="checkbox" disabled={have} checked={!have && !!picked[k]} onChange={e => setPicked(p => ({ ...p, [k]: e.target.checked }))} />
                      <span className="text-white">{s.name}</span>
                      <span className="text-slate-500">{s.ip}{s.resolution ? ` · ${s.resolution}` : ''}{s.encoding ? ` · ${s.encoding}` : ''}</span>
                      {have && <span className="ml-auto text-xs text-slate-400 flex items-center gap-1"><Check size={13} /> уже добавлена</span>}
                      {!have && !s.browser_ok && <span className="ml-auto text-xs text-amber-300">H.265 — в браузере LIVE может не показаться</span>}
                    </label>
                  );
                })}
              </div>
              <button onClick={addPicked} disabled={busy || toAdd === 0} className="px-4 py-2 rounded-lg bg-primary text-white text-sm disabled:opacity-40">
                Добавить выбранные ({toAdd})
              </button>
              {added !== null && <div className="text-sm text-green-400">Добавлено камер: {added}. Бридж подхватит их на следующем цикле.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
