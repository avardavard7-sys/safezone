'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { useObjectProfile } from '@/lib/object-profile';
import { ShieldAlert, Trash2, Upload, Camera as CamIcon } from 'lucide-react';
import { enrollFromFile } from '@/lib/face-worker-client';

type Entry = {
  id: string; label: string; reason: string; created_at: string; expires_at: string;
  status: 'pending' | 'ready' | 'no_face' | 'many_faces' | 'too_small'; status_message: string | null; face_thumb: string | null;
};
type Cam = { id: string; name: string; face_check: boolean };

const STATUS: Record<Entry['status'], { text: string; cls: string }> = {
  pending: { text: 'обрабатывается бриджем', cls: 'text-amber-300' },
  ready: { text: 'в работе', cls: 'text-green-400' },
  no_face: { text: 'лицо не найдено', cls: 'text-red-400' },
  many_faces: { text: 'несколько лиц', cls: 'text-red-400' },
  too_small: { text: 'лицо слишком мелкое', cls: 'text-red-400' },
};
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });

export default function BlacklistPage() {
  const sb = createClient();
  const { profile, has } = useObjectProfile();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cams, setCams] = useState<Cam[]>([]);
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [months, setMonths] = useState(6);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [e, c] = await Promise.all([
      sb.from('blacklist_entries').select('id,label,reason,created_at,expires_at,status,status_message,face_thumb').order('created_at', { ascending: false }),
      sb.from('cameras').select('id,name,face_check').eq('is_active', true).order('name'),
    ]);
    if (e.error) setError(e.error.message); else setEntries((e.data as Entry[]) || []);
    setCams((c.data as Cam[]) || []);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!entries.some(e => e.status === 'pending')) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [entries, load]);

  async function add() {
    if (!profile || !file || !label.trim() || reason.trim().length < 5) return;
    setBusy(true); setError(null);
    try {
      // лицо находится и превращается в отпечаток прямо в браузере — исходное фото
      // никуда не отправляется, и бридж для этого не нужен
      setError(null);
      const face = await enrollFromFile(file);
      if ('reason' in face) { setError(`Фото не подошло: ${face.reason}`); return; }
      const { data: u } = await sb.auth.getUser();
      const expires = new Date(); expires.setMonth(expires.getMonth() + months);
      const { error } = await sb.from('blacklist_entries').insert({
        mall_id: profile.mall_id, added_by: u.user?.id, label: label.trim(), reason: reason.trim(),
        expires_at: expires.toISOString(), status: 'ready',
        embedding: face.emb, face_thumb: face.thumb.split(',')[1],
      });
      if (error) throw error;
      setLabel(''); setReason(''); setFile(null);
      load();
    } catch (e: any) { setError(e.message || 'Не получилось добавить'); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm('Удалить запись из чёрного списка? Лицо и отпечаток будут удалены.')) return;
    const { error } = await sb.from('blacklist_entries').delete().eq('id', id);
    if (error) setError(error.message); else load();
  }

  async function toggleCam(c: Cam) {
    const { error } = await sb.from('cameras').update({ face_check: !c.face_check }).eq('id', c.id);
    if (error) setError(error.message); else load();
  }

  if (profile && !has('blacklist')) {
    return (
      <DashboardLayout>
        <Card className="text-slate-300">
          Чёрный список выключен. Включить его может администратор в «Профиле объекта» — с подтверждением,
          что правовое основание согласовано с юристом.
        </Card>
      </DashboardLayout>
    );
  }
  if (profile && !profile.can_manage) {
    return <DashboardLayout><Card className="text-slate-300">Чёрный список доступен только администратору объекта.</Card></DashboardLayout>;
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold font-display text-white">Чёрный список</h1>
          <p className="text-slate-400 mt-1 max-w-3xl">
            Сохраняются только лица из этого списка. Лица остальных посетителей сравниваются в памяти
            и сразу удаляются. Система сообщает о <b>возможном совпадении</b> — решение принимает человек.
          </p>
        </div>

        {error && <Card className="!p-4 border border-danger/40 text-red-400">{error}</Card>}

        <Card className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Добавить</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Как подписать: «Мужчина, кража 12.10»"
              className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white" />
            <select value={months} onChange={e => setMonths(+e.target.value)}
              className="bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white">
              <option value={3}>Хранить 3 месяца</option>
              <option value={6}>Хранить 6 месяцев</option>
              <option value={12}>Хранить 12 месяцев</option>
            </select>
          </div>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
            placeholder="Причина — обязательно: что произошло, когда, есть ли акт или заявление"
            className="w-full bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white" />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-200 text-white cursor-pointer hover:bg-surface-300">
              <Upload size={16} /> {file ? file.name : 'Фото лица'}
              <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
            </label>
            <button disabled={busy || !file || !label.trim() || reason.trim().length < 5} onClick={add}
              className="px-4 py-2 rounded-lg bg-primary text-white disabled:opacity-40">
              {busy ? 'Ищу лицо на фото…' : 'Добавить в список'}
            </button>
            <span className="text-sm text-slate-500">Лицо крупно, анфас, один человек на фото. Фото обрабатывается в вашем браузере и никуда не отправляется.</span>
          </div>
        </Card>

        <Card className="p-0 overflow-hidden">
          <div className="px-6 pt-5 pb-3 text-lg font-semibold text-white">В списке: {entries.length}</div>
          {entries.length === 0 && <p className="px-6 pb-5 text-slate-400">Список пуст — лица не проверяются.</p>}
          <div className="divide-y divide-surface-300">
            {entries.map(e => (
              <div key={e.id} className="flex items-center gap-4 px-6 py-4">
                {e.face_thumb
                  ? <img src={`data:image/jpeg;base64,${e.face_thumb}`} alt={e.label} className="w-16 h-16 rounded-lg object-cover" />
                  : <div className="w-16 h-16 rounded-lg bg-surface-300 flex items-center justify-center"><ShieldAlert className="text-slate-500" /></div>}
                <div className="flex-1 min-w-0">
                  <div className="text-white">{e.label}</div>
                  <div className="text-sm text-slate-400">{e.reason}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Добавлен {date(e.created_at)} · удалится {date(e.expires_at)} ·{' '}
                    <span className={STATUS[e.status].cls}>{e.status_message || STATUS[e.status].text}</span>
                  </div>
                </div>
                <button onClick={() => remove(e.id)} className="text-slate-500 hover:text-red-400" aria-label="Удалить запись"><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="space-y-2">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2"><CamIcon size={18} /> Камеры проверки лиц</h2>
          <p className="text-sm text-slate-400">
            Включайте только камеры на входе, где лицо видно крупно и на уровне глаз. Лица меньше 60 пикселей не сравниваются.
          </p>
          {cams.map(c => (
            <label key={c.id} className="flex items-center gap-3 py-1 text-white cursor-pointer">
              <input type="checkbox" checked={c.face_check} onChange={() => toggleCam(c)} /> {c.name}
            </label>
          ))}
        </Card>
      </div>
    </DashboardLayout>
  );
}
