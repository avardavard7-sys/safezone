'use client';

/**
 * BridgeSettings.tsx — страница «Функции» в админке.
 *
 * Тумблеры строятся АВТОМАТИЧЕСКИ из схемы, которую отдаёт бридж (`GET /settings`).
 * Добавлю новую функцию в бридж — она сама появится здесь, править этот файл не нужно.
 *
 * Куда положить:  components/BridgeSettings.tsx
 * Подключить:     <BridgeSettings mallId={MALL_ID} supabase={supabase} />
 *
 * Перед первым запуском выполнить MIGRATION-v7.7-settings.sql в Supabase.
 */

import { useEffect, useState } from 'react';

const BRIDGE = process.env.NEXT_PUBLIC_BRIDGE_API || 'http://127.0.0.1:8099';

type Item = {
  key: string; type: 'bool' | 'int' | 'num' | 'enum' | 'str' | 'time';
  def: any; restart: boolean; label: string; hint?: string;
  values?: string[]; min?: number; max?: number; step?: number;
};

export default function BridgeSettings({ mallId, supabase }: { mallId: string; supabase: any }) {
  const [groups, setGroups] = useState<Record<string, Item[]>>({});
  const [values, setValues] = useState<Record<string, any>>({});
  const [dirty, setDirty] = useState<Record<string, any>>({});
  const [source, setSource] = useState<string>('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`${BRIDGE}/settings`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'бридж не отдал настройки');
      setGroups(d.schema);
      setValues(d.current);
      setSource(d.source);
      if (d.source === 'env') {
        setError('Бридж не видит таблицу bridge_settings — настройки читаются из .env и здесь не сохранятся. Выполни MIGRATION-v7.7-settings.sql в Supabase.');
      }
    } catch (e: any) {
      setError(
        String(e.message).includes('fetch')
          ? `Бридж не отвечает на ${BRIDGE}. Запущен ли он? Проверь: docker ps`
          : e.message
      );
    }
  }

  const merged = { ...values, ...dirty };
  const changedKeys = Object.keys(dirty).filter(k => String(dirty[k]) !== String(values[k]));
  const restartNeeded = changedKeys.filter(k =>
    Object.values(groups).flat().find(i => i.key === k)?.restart);

  async function save() {
    setSaving(true); setError(null); setStatus(null);
    try {
      const config: Record<string, any> = {};
      for (const [k, v] of Object.entries(merged)) config[k] = v;

      const { error: dbErr } = await supabase
        .from('bridge_settings')
        .upsert({ mall_id: mallId, config, updated_at: new Date().toISOString() }, { onConflict: 'mall_id' });
      if (dbErr) throw new Error(dbErr.message);

      // просим бридж перечитать сразу, не дожидаясь цикла
      try {
        const r = await fetch(`${BRIDGE}/settings/reload`, { method: 'POST' });
        const d = await r.json();
        if (d.current) setValues(d.current);
      } catch { /* бридж подхватит сам на следующем цикле */ }

      setDirty({});
      setStatus(restartNeeded.length
        ? `Сохранено. Требуют перезапуска бриджа: ${restartNeeded.join(', ')}`
        : 'Сохранено и применено — бридж уже работает по-новому');
    } catch (e: any) {
      setError(`Не сохранилось: ${e.message}`);
    } finally { setSaving(false); }
  }

  function reset() { setDirty({}); setStatus(null); }

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Функции анализа</h2>
        {source && <span style={badge}>{source === 'db' ? 'управляется отсюда' : 'только .env'}</span>}
      </div>
      <p style={{ color: '#8b95a5', fontSize: 13.5, marginTop: 0 }}>
        Изменения применяются на лету — бридж подхватывает их за несколько секунд.
        Настройки с пометкой «нужен перезапуск» вступят в силу после рестарта.
      </p>

      {error && <div style={errBox}>{error}</div>}
      {status && <div style={okBox}>{status}</div>}

      {Object.entries(groups).map(([group, items]) => (
        <section key={group} style={card}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, color: '#c9d1d9' }}>{group}</h3>
          {items.map(item => (
            <Row key={item.key} item={item}
                 value={merged[item.key]}
                 changed={changedKeys.includes(item.key)}
                 onChange={v => setDirty(d => ({ ...d, [item.key]: v }))} />
          ))}
        </section>
      ))}

      {changedKeys.length > 0 && (
        <div style={bar}>
          <span style={{ fontSize: 13.5 }}>Изменено: {changedKeys.length}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={reset} style={btnGhost}>Отменить</button>
            <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? .6 : 1 }}>
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ item, value, changed, onChange }: any) {
  return (
    <div style={{ ...row, ...(changed ? { borderColor: '#4f46e5' } : {}) }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>
          {item.label}
          {item.restart && <span style={warnBadge}>нужен перезапуск</span>}
        </div>
        {item.hint && <div style={{ fontSize: 12.5, color: '#8b95a5', marginTop: 3 }}>{item.hint}</div>}
      </div>

      <div style={{ flexShrink: 0 }}>
        {item.type === 'bool' && (
          <button onClick={() => onChange(!value)}
                  style={{ ...toggle, background: value ? '#4f46e5' : '#30363d' }}
                  aria-pressed={!!value}>
            <span style={{ ...knob, transform: value ? 'translateX(20px)' : 'translateX(0)' }} />
          </button>
        )}
        {item.type === 'enum' && (
          <select value={value} onChange={e => onChange(e.target.value)} style={input}>
            {item.values.map((v: string) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        {(item.type === 'int' || item.type === 'num') && (
          <input type="number" value={value} min={item.min} max={item.max} step={item.step || 1}
                 onChange={e => onChange(item.type === 'int' ? parseInt(e.target.value) : parseFloat(e.target.value))}
                 style={{ ...input, width: 110 }} />
        )}
        {item.type === 'time' && (
          <input type="time" value={value} onChange={e => onChange(e.target.value)} style={{ ...input, width: 120 }} />
        )}
        {item.type === 'str' && (
          <input value={value} onChange={e => onChange(e.target.value)} style={{ ...input, width: 240 }} />
        )}
      </div>
    </div>
  );
}

const card: any = { background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 16, marginTop: 14 };
const row: any = { display: 'flex', alignItems: 'center', gap: 16, padding: '11px 12px', borderRadius: 9, border: '1px solid transparent', background: '#0d1117', marginBottom: 8 };
const input: any = { padding: '7px 10px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 7, color: '#e6edf3', fontSize: 14 };
const toggle: any = { width: 44, height: 24, borderRadius: 20, border: 0, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', transition: 'background .15s' };
const knob: any = { width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'transform .15s', display: 'block' };
const btnPrimary: any = { padding: '9px 18px', background: '#4f46e5', color: '#fff', border: 0, borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 };
const btnGhost: any = { padding: '9px 16px', background: 'transparent', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 8, cursor: 'pointer', fontSize: 14 };
const bar: any = { position: 'sticky', bottom: 16, marginTop: 16, padding: '12px 16px', background: '#161b22', border: '1px solid #4f46e5', borderRadius: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.4)' };
const errBox: any = { padding: '11px 13px', background: '#2d1618', border: '1px solid #6b2429', borderRadius: 9, color: '#ffb4ab', fontSize: 13.5, marginBottom: 12 };
const okBox: any = { padding: '11px 13px', background: '#12261a', border: '1px solid #2d5a3d', borderRadius: 9, color: '#7ee787', fontSize: 13.5, marginBottom: 12 };
const badge: any = { fontSize: 11.5, padding: '3px 9px', background: '#1f2937', color: '#9ca3af', borderRadius: 20 };
const warnBadge: any = { marginLeft: 8, fontSize: 11, padding: '2px 7px', background: '#3a2a12', color: '#f0b849', borderRadius: 20 };
