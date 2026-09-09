'use client';

/**
 * CameraDiscovery — кнопки «Найти камеры» (ONVIF) и «Проверить» (живой кадр).
 *
 * Браузер НЕ соединяется с бриджом напрямую. Панель кладёт команду в Supabase,
 * бридж забирает её на своём цикле (~5 сек), выполняет и пишет результат обратно.
 *
 * Благодаря этому кнопки работают из облачной панели по https и даже с телефона —
 * клиенту не нужно ничего поднимать локально и настраивать сеть.
 *
 * Требуется: таблица bridge_commands (MIGRATION-v7.9-commands.sql) и бридж v7.9+.
 */

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

// Браузер НЕ ходит на localhost: команда кладётся в Supabase, бридж её забирает
// на своём цикле, выполняет и пишет результат. Поэтому кнопки работают из
// облачной панели по https и с телефона — клиенту не нужно ничего поднимать.
const POLL_MS = 2000;
const TIMEOUT_MS = 200000;

type Suggestion = {
  host: string; manufacturer: string | null; model: string | null;
  profile: string; resolution: string | null;
  ip: string; port: number; path: string; is_substream: boolean;
};

export function CameraDiscovery({ onAdd }: { onAdd?: (cam: any) => void }) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [subnet, setSubnet] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [found, setFound] = useState<Suggestion[]>([]);
  const [preview, setPreview] = useState<Record<string, any>>({});
  const [stage, setStage] = useState('');

  const timers = useRef<any[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** Кладёт команду в очередь и ждёт, пока бридж её выполнит */
  async function runCommand(kind: 'discover' | 'probe', params: any, onStage?: (s: string) => void) {
    const sb = createClient();
    const { data: { user: u } } = await sb.auth.getUser();
    const { data: profile } = await sb.from('profiles').select('mall_id').eq('id', u?.id ?? '').maybeSingle();
    if (!profile?.mall_id) throw new Error('не удалось определить объект — перезайди в панель');

    const { data: cmd, error: insErr } = await sb.from('bridge_commands')
      .insert({ mall_id: profile.mall_id, kind, params, created_by: u?.id })
      .select().single();
    if (insErr) {
      throw new Error(/relation|does not exist|schema cache/i.test(insErr.message)
        ? 'В базе нет таблицы bridge_commands — выполни MIGRATION-v7.9-commands.sql'
        : insErr.message);
    }

    const started = Date.now();
    onStage?.('Команда отправлена, жду бридж…');
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise(r => timers.current.push(setTimeout(r, POLL_MS)));
      const { data: row } = await sb.from('bridge_commands')
        .select('status,result,error').eq('id', cmd.id).maybeSingle();
      if (!row) continue;
      if (row.status === 'running') onStage?.('Бридж выполняет…');
      if (row.status === 'done') return row.result;
      if (row.status === 'error') throw new Error(row.error || 'бридж вернул ошибку');
    }
    throw new Error('бридж не ответил. Он запущен на объекте? Проверь: docker ps');
  }

  async function discover() {
    setBusy(true); setError(null); setFound([]); setLogs([]); setPreview({});
    setStage('Отправляю команду…');
    try {
      const res = await runCommand('discover',
        { user, pass, subnet: subnet.trim() || null, multicast: true }, setStage);
      setFound(res?.suggestions || []);
      setLogs(res?.logs || []);
      if (!res?.suggestions?.length) {
        setError('Камеры не найдены. Впиши подсеть вручную (например 192.168.10) — в Docker на Windows мультикаст часто зарезан.');
      }
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); setStage(''); }
  }

  async function probe(s: Suggestion) {
    const key = s.ip + s.path;
    setPreview(p => ({ ...p, [key]: { loading: true } }));
    try {
      const res = await runCommand('probe',
        { ip: s.ip, port: s.port, username: user, password: pass, path: s.path });
      setPreview(p => ({ ...p, [key]: { ok: true, ...res } }));
    } catch (e: any) {
      setPreview(p => ({ ...p, [key]: { ok: false, error: e.message } }));
    }
  }

  function add(s: Suggestion) {
    // Поля СТРОГО как в таблице public.cameras:
    // ip_address, username, password, rtsp_path, port, name, floor, is_active
    // (колонок vendor/channel/resolution в схеме НЕТ — производитель и канал
    //  фронтенд использует только чтобы собрать rtsp_path)
    onAdd?.({
      name: `${s.manufacturer || 'Камера'} ${s.host}${s.is_substream ? ' (суб)' : ''}`,
      ip_address: s.ip,
      port: s.port,
      username: user,
      password: pass,
      rtsp_path: s.path,
      is_active: true,
      ai_enabled: true,
      floor: 1,
      // справочно для формы, в БД не пишется:
      _manufacturer: s.manufacturer,
      _model: s.model,
      _resolution: s.resolution,
    });
  }

  return (
    <div style={{ margin: '16px 0' }}>
      <button onClick={() => setOpen(!open)} style={btnPrimary}>
        🔍 Найти камеры в сети
      </button>

      {open && (
        <div style={panel}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Логин" value={user} onChange={setUser} width={140} />
            <Field label="Пароль" value={pass} onChange={setPass} width={180} type="password" />
            <Field label="Подсеть (если не нашлось)" value={subnet} onChange={setSubnet}
                   width={200} placeholder="192.168.10" />
            <button onClick={discover} disabled={busy} style={{ ...btnPrimary, opacity: busy ? .6 : 1 }}>
              {busy ? 'Ищу…' : 'Искать'}
            </button>
          </div>

          <p style={hint}>
            Логин и пароль — от <b>камеры</b>, не от облачного аккаунта.
            Одинаковые для всех камер объекта? Тогда найдутся все разом. Поиск идёт через бридж, поэтому занимает несколько секунд.
          </p>

          {stage && <p style={{ marginTop: 10, fontSize: 13.5, color: '#818cf8' }}>{stage}</p>}
          {error && <div style={errBox}>{error}</div>}

          {logs.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#8b95a5' }}>Журнал поиска</summary>
              <pre style={pre}>{logs.join('\n')}</pre>
            </details>
          )}

          {found.map(s => {
            const pv = preview[s.ip + s.path];
            return (
              <div key={s.ip + s.path} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {s.manufacturer || 'Камера'} {s.model || ''}
                      {s.is_substream && <span style={badge}>субпоток</span>}
                    </div>
                    <div style={{ fontSize: 13, color: '#8b95a5', marginTop: 4 }}>
                      {s.ip}:{s.port} · {s.resolution || '?'} · {s.profile}
                    </div>
                    <code style={code}>{s.path}</code>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <button onClick={() => probe(s)} style={btnGhost}>
                      {pv?.loading ? '…' : '👁 Проверить'}
                    </button>
                    <button onClick={() => add(s)} style={btnPrimary}>+ Добавить</button>
                  </div>
                </div>

                {pv && !pv.loading && (
                  pv.ok ? (
                    <div style={{ marginTop: 10 }}>
                      <img src={pv.preview} alt="кадр" style={{ maxWidth: '100%', borderRadius: 8 }} />
                      <div style={{ fontSize: 13, color: '#8b95a5', marginTop: 6 }}>
                        Кадр {pv.size_kb} КБ за {pv.took_sec}с · людей в кадре: {pv.people}
                        {pv.detections?.length > 0 &&
                          ` · детектор видит: ${pv.detections.map((d: any) => `${d.cls} ${Math.round(d.conf * 100)}%`).join(', ')}`}
                      </div>
                    </div>
                  ) : (
                    <div style={errBox}>{pv.error}{pv.hint ? ` — ${pv.hint}` : ''}</div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, width, type, placeholder }: any) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12, color: '#8b95a5', marginBottom: 4 }}>{label}</span>
      <input type={type || 'text'} value={value} placeholder={placeholder}
             onChange={e => onChange(e.target.value)} style={{ ...input, width }} />
    </label>
  );
}

const btnPrimary: any = { padding: '9px 16px', background: '#4f46e5', color: '#fff', border: 0, borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 };
const btnGhost: any = { padding: '9px 14px', background: 'transparent', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 8, cursor: 'pointer', fontSize: 14 };
const panel: any = { marginTop: 12, padding: 16, background: '#161b22', border: '1px solid #30363d', borderRadius: 10 };
const input: any = { padding: '9px 11px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 8, color: '#e6edf3', fontSize: 14 };
const hint: any = { fontSize: 12.5, color: '#8b95a5', marginTop: 10, lineHeight: 1.5 };
const errBox: any = { marginTop: 10, padding: '10px 12px', background: '#2d1618', border: '1px solid #6b2429', borderRadius: 8, color: '#ffb4ab', fontSize: 13.5 };
const card: any = { marginTop: 12, padding: 14, background: '#0d1117', border: '1px solid #30363d', borderRadius: 10 };
const code: any = { display: 'inline-block', marginTop: 6, fontSize: 12, color: '#7ee787', background: '#0b0f14', padding: '3px 7px', borderRadius: 5 };
const badge: any = { marginLeft: 8, fontSize: 11, padding: '2px 7px', background: '#1f2937', color: '#9ca3af', borderRadius: 20 };
const pre: any = { fontSize: 12, color: '#8b95a5', background: '#0d1117', padding: 10, borderRadius: 8, overflowX: 'auto', marginTop: 6 };


export default CameraDiscovery;
