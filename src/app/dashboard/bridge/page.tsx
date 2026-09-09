'use client';

/**
 * Страница «Бридж» — подключение объекта в два шага.
 *
 * Клиенту не нужно знать про MALL_ID, .env и docker-команды: он получает код,
 * вводит его в установщик, и бридж сам забирает объект, телеграм и настройки.
 */

import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Server, Copy, RefreshCw, Trash2, CheckCircle2, XCircle, Clock, Download, Terminal } from 'lucide-react';
import toast from 'react-hot-toast';

type Bridge = {
  id: string; name: string; status: string;
  pairing_code: string | null; code_expires: string | null;
  last_seen_at: string | null; version: string | null; platform: string | null;
  stats: any; paired_at: string | null; created_at: string;
};

export default function BridgePage() {
  const { mall } = useAuth();
  const [list, setList] = useState<Bridge[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!mall?.id) return;
    load();
    const t = setInterval(load, 15000);   // статус обновляется сам
    return () => clearInterval(t);
  }, [mall?.id]);

  async function load() {
    const sb = createClient();
    await sb.rpc('mark_stale_bridges');   // молчит больше 2 минут → офлайн
    const { data, error } = await sb.from('bridges').select('*')
      .eq('mall_id', mall?.id).order('created_at', { ascending: false });
    if (error && !/relation|does not exist/i.test(error.message)) toast.error(error.message);
    setList(data || []);
    setLoading(false);
  }

  async function create() {
    setCreating(true);
    try {
      const sb = createClient();
      const { data, error } = await sb.rpc('create_bridge', { bridge_name: name.trim() || 'Бридж' });
      if (error) throw new Error(error.message);
      toast.success(`Код готов: ${data.pairing_code}`);
      setName('');
      await load();
    } catch (e: any) {
      toast.error(`Не удалось создать: ${e.message}`);
    } finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm('Отвязать бридж? Он перестанет присылать события, пока не привяжешь заново.')) return;
    const sb = createClient();
    const { error } = await sb.from('bridges').delete().eq('id', id);
    if (error) toast.error(error.message);
    else { toast.success('Бридж отвязан'); load(); }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast.success('Скопировано');
  }

  const online = list.filter(b => b.status === 'online').length;
  const waiting = list.filter(b => b.pairing_code).length;

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-white">Бридж</h1>
        <p className="text-slate-400 text-sm">
          Программа на компьютере объекта: забирает видео с камер, анализирует локально
          и присылает сюда только события. Подключается одним кодом.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-5">
        <Stat label="Подключено" value={online} tone={online ? 'success' : 'muted'} />
        <Stat label="Ждут привязки" value={waiting} tone={waiting ? 'warning' : 'muted'} />
        <Stat label="Всего" value={list.length} tone="muted" />
      </div>

      <Card className="mb-5">
        <h2 className="text-white font-medium mb-1">Подключить компьютер объекта</h2>
        <p className="text-sm text-slate-400 mb-4">
          Создай код, установи программу на компьютере объекта и введи код при установке.
          Больше ничего настраивать не нужно.
        </p>
        <div className="flex gap-2 flex-wrap">
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="Название, например: Компьютер кассы"
            className="flex-1 min-w-[200px] px-3 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white text-sm focus:border-primary focus:outline-none" />
          <Button onClick={create} loading={creating}>
            <Server className="w-4 h-4" /> Получить код
          </Button>
        </div>
      </Card>

      {loading ? (
        <p className="text-slate-500 text-sm">Загрузка…</p>
      ) : !list.length ? (
        <Card className="text-center py-10">
          <Server className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p className="text-white">Пока ни один компьютер не подключён</p>
          <p className="text-sm text-slate-400 mt-1">Получи код выше, чтобы подключить первый</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map(b => <BridgeCard key={b.id} b={b} onCopy={copy} onRemove={remove} />)}
        </div>
      )}

      <Card className="mt-5">
        <h3 className="text-white font-medium mb-3 flex items-center gap-2">
          <Terminal className="w-4 h-4" /> Как установить на компьютере объекта
        </h3>
        <ol className="text-sm text-slate-400 space-y-2 list-decimal list-inside">
          <li>Установить <b className="text-white">Docker Desktop</b> и запустить его</li>
          <li>Скачать и распаковать архив бриджа</li>
          <li>Запустить <code className="text-success">start.bat</code> и ввести код из этой страницы</li>
        </ol>
        <p className="text-xs text-slate-500 mt-3">
          Дальше программа работает сама и запускается вместе с компьютером.
          Объект, телеграм и все настройки приезжают из панели — вручную ничего вписывать не нужно.
        </p>
      </Card>
    </DashboardLayout>
  );
}

function BridgeCard({ b, onCopy, onRemove }: any) {
  const s = b.stats || {};
  const seen = b.last_seen_at ? new Date(b.last_seen_at) : null;
  const ago = seen ? Math.round((Date.now() - seen.getTime()) / 1000) : null;
  const agoText = ago === null ? '—'
    : ago < 60 ? `${ago} сек назад`
    : ago < 3600 ? `${Math.round(ago / 60)} мин назад`
    : `${Math.round(ago / 3600)} ч назад`;

  return (
    <Card>
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {b.status === 'online'
              ? <CheckCircle2 className="w-5 h-5 text-success" />
              : b.pairing_code ? <Clock className="w-5 h-5 text-warning" />
              : <XCircle className="w-5 h-5 text-danger" />}
            <span className="text-white font-medium">{b.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              b.status === 'online' ? 'bg-success/15 text-success'
              : b.pairing_code ? 'bg-warning/15 text-warning' : 'bg-danger/15 text-danger'}`}>
              {b.status === 'online' ? 'на связи' : b.pairing_code ? 'ждёт подключения' : 'нет связи'}
            </span>
          </div>

          {b.pairing_code ? (
            <div className="mt-3">
              <p className="text-xs text-slate-400 mb-1">Код для установки (действует 24 часа)</p>
              <div className="flex items-center gap-2">
                <code className="text-2xl font-mono tracking-[0.25em] text-primary bg-surface-200 px-4 py-2 rounded-xl">
                  {b.pairing_code}
                </code>
                <Button size="sm" variant="ghost" onClick={() => onCopy(b.pairing_code)}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-slate-400 space-y-0.5">
              <p>Последний сигнал: {agoText}</p>
              {s.cameras !== undefined && (
                <p>Камер в работе: {s.cameras} · детектор {s.detector || '—'}
                  {s.zones ? ` · зон ${s.zones}` : ''}</p>
              )}
              {b.version && <p className="text-xs text-slate-500">Версия {b.version} · {b.platform || '—'}</p>}
            </div>
          )}
        </div>

        <button onClick={() => onRemove(b.id)} className="text-slate-500 hover:text-danger" title="Отвязать">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: any) {
  const c: any = { success: 'text-success', warning: 'text-warning', muted: 'text-slate-300' };
  return (
    <div className="glass-card p-4">
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`text-2xl font-bold font-display ${c[tone]}`}>{value}</p>
    </div>
  );
}
