'use client';

/**
 * CameraDiscovery.tsx — кнопки «Найти камеры» и «Проверить» для страницы камер.
 *
 * Куда положить:  components/CameraDiscovery.tsx
 * Как подключить (на странице со списком камер):
 *
 *   import CameraDiscovery from '@/components/CameraDiscovery';
 *   ...
 *   <CameraDiscovery onAdd={async (cam) => {
 *     const { _manufacturer, _model, _resolution, ...row } = cam;
 *     await supabase.from('cameras').insert({ ...row, mall_id: MALL_ID });
 *   }} />
 *
 * Поля совпадают с таблицей public.cameras: name, ip_address, port,
 * username, password, rtsp_path, floor, is_active, ai_enabled.
 * Поля с префиксом _ — справочные для UI, в БД их писать не нужно.
 *
 * Важно: бридж крутится на ПК оператора и слушает 127.0.0.1:8099.
 * Браузер оператора на том же ПК — значит достучится. Наружу порт не торчит.
 *
 * Если админка открыта по https, браузер заблокирует запрос к http://127.0.0.1
 * (mixed content). Решения: открывать админку локально по http, или запускать
 * бридж с API_HOST=0.0.0.0 и ходить по IP машины, или поставить локальный https.
 */

import { useState } from 'react';

const BRIDGE = process.env.NEXT_PUBLIC_BRIDGE_API || 'http://127.0.0.1:8099';

type Suggestion = {
  host: string; manufacturer: string | null; model: string | null;
  profile: string; resolution: string | null;
  ip: string; port: number; path: string; rtsp: string;
  snapshot: string | null; is_substream: boolean;
};

export default function CameraDiscovery({ onAdd }: { onAdd?: (cam: any) => void }) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [subnet, setSubnet] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [found, setFound] = useState<Suggestion[]>([]);
  const [preview, setPreview] = useState<Record<string, any>>({});

  async function discover() {
    setBusy(true); setError(null); setFound([]); setLogs([]);
    try {
      const r = await fetch(`${BRIDGE}/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, pass, subnet: subnet.trim() || null, multicast: true }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'поиск не удался');
      setFound(d.suggestions || []);
      setLogs(d.logs || []);
      if (!d.suggestions?.length) {
        setError('Камеры не найдены. Впиши подсеть вручную (например 192.168.10) — multicast часто зарезан в Docker на Windows.');
      }
    } catch (e: any) {
      setError(
        e.message?.includes('fetch')
          ? 'Бридж не отвечает на 127.0.0.1:8099. Запущен ли он? (docker ps)'
          : e.message
      );
    } finally { setBusy(false); }
  }

  async function probe(s: Suggestion) {
    const key = s.rtsp;
    setPreview(p => ({ ...p, [key]: { loading: true } }));
    try {
      const r = await fetch(`${BRIDGE}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: s.ip, port: s.port, login: user, password: pass, path: s.path }),
      });
      const body = await r.json();
      setPreview(p => ({ ...p, [key]: body }));
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
            Одинаковые для всех камер объекта? Тогда найдутся все разом.
          </p>

          {error && <div style={errBox}>{error}</div>}

          {logs.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#8b95a5' }}>Журнал поиска</summary>
              <pre style={pre}>{logs.join('\n')}</pre>
            </details>
          )}

          {found.map(s => {
            const pv = preview[s.rtsp];
            return (
              <div key={s.rtsp} style={card}>
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
