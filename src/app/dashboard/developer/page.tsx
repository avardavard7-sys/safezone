'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SeverityBadge, TypeBadge } from '@/components/ui/Badge';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import {
  Check, X, Code, Clock, ShieldAlert, Building2, Users as UsersIcon,
  Camera, AlertTriangle, Activity, Database, Zap, Cpu, Terminal,
  Trash2, UserCheck, UserX, Search, RefreshCw, Server, FileText
} from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDate, formatTimeAgo } from '@/lib/utils';

type Tab = 'overview' | 'malls' | 'users' | 'events' | 'audit' | 'system';

export default function DevPage() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');

  const [malls, setMalls] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [cameras, setCameras] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sysStatus, setSysStatus] = useState<any>(null);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    const sb = createClient();
    const [m, u, e, c, a] = await Promise.all([
      sb.from('malls').select('*').order('created_at', { ascending: false }),
      sb.from('profiles').select('*').order('created_at', { ascending: false }),
      sb.from('events').select('*').order('created_at', { ascending: false }).limit(200),
      sb.from('cameras').select('*'),
      sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(300),
    ]);
    setMalls(m.data || []);
    setUsers(u.data || []);
    setEvents(e.data || []);
    setCameras(c.data || []);
    setAuditLogs(a.data || []);
    setLoading(false);
  };

  if (profile?.username !== 'hodkonem' && profile?.role !== 'developer') {
    return (
      <DashboardLayout>
        <Card>
          <div className="text-center py-8">
            <ShieldAlert className="w-12 h-12 text-danger mx-auto mb-3" />
            <p className="text-danger">Доступ запрещён</p>
          </div>
        </Card>
      </DashboardLayout>
    );
  }

  const approveMall = async (id: string, v: boolean) => {
    const sb = createClient();
    await sb.from('malls').update({ is_approved: v }).eq('id', id);
    if (v) await sb.from('profiles').update({ is_approved: true }).eq('mall_id', id);
    toast.success(v ? '✅ Одобрено' : '❌ Отклонено');
    loadAll();
  };

  const deleteMall = async (id: string, name: string) => {
    if (!confirm(`Удалить ТРЦ "${name}" и ВСЕ его данные (камеры, события, юзеры)? Это необратимо!`)) return;
    const sb = createClient();
    await sb.from('malls').delete().eq('id', id);
    toast.success('ТРЦ удалён');
    loadAll();
  };

  const toggleUser = async (id: string, isApproved: boolean) => {
    const sb = createClient();
    await sb.from('profiles').update({ is_approved: !isApproved }).eq('id', id);
    toast.success(!isApproved ? '✅ Активирован' : '🔒 Заблокирован');
    loadAll();
  };

  const changeRole = async (id: string, role: string) => {
    const sb = createClient();
    await sb.from('profiles').update({ role }).eq('id', id);
    toast.success(`Роль → ${role}`);
    loadAll();
  };

  const deleteUser = async (id: string, username: string) => {
    if (!confirm(`Удалить пользователя "${username}"?`)) return;
    const sb = createClient();
    await sb.from('profiles').delete().eq('id', id);
    toast.success('Удалён');
    loadAll();
  };

  const clearAllEvents = async () => {
    if (!confirm('Удалить ВСЕ инциденты из ВСЕХ ТРЦ? Это необратимо!')) return;
    const sb = createClient();
    await sb.from('events').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    toast.success('Все инциденты очищены');
    loadAll();
  };

  const checkSystem = async () => {
    setLoading(true);
    const checks: any = {
      supabase: { ok: false, msg: 'Проверка...' },
      openai: { ok: false, msg: 'Не протестирован' },
      telegram: { ok: false, msg: 'Не протестирован' },
      realtime: { ok: false, msg: 'Проверка...' },
    };

    try {
      const sb = createClient();
      const { error } = await sb.from('malls').select('id').limit(1);
      checks.supabase = error
        ? { ok: false, msg: error.message }
        : { ok: true, msg: 'БД отвечает' };
    } catch (e: any) {
      checks.supabase = { ok: false, msg: e.message };
    }

    try {
      const sb = createClient();
      const ch = sb.channel('health-check');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 3000);
        ch.subscribe((s) => {
          if (s === 'SUBSCRIBED') { clearTimeout(t); checks.realtime = { ok: true, msg: 'Realtime OK' }; resolve(); }
        });
      });
      sb.removeChannel(ch);
      if (!checks.realtime.ok) checks.realtime = { ok: false, msg: 'Таймаут подключения' };
    } catch (e: any) {
      checks.realtime = { ok: false, msg: e.message };
    }

    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: '', camera_name: 'ping' }),
      });
      const data = await res.json();
      checks.openai = data.error
        ? { ok: false, msg: 'API ошибка' }
        : { ok: true, msg: 'Endpoint работает' };
    } catch (e: any) {
      checks.openai = { ok: false, msg: e.message };
    }

    try {
      const res = await fetch('/api/notifications/telegram', { method: 'GET' });
      checks.telegram = res.ok
        ? { ok: true, msg: 'Endpoint доступен' }
        : { ok: false, msg: `HTTP ${res.status}` };
    } catch (e: any) {
      checks.telegram = { ok: false, msg: e.message };
    }

    setSysStatus(checks);
    setLoading(false);
    toast.success('Проверка системы завершена');
  };

  const pendingMalls = malls.filter(m => !m.is_approved);
  const activeMalls = malls.filter(m => m.is_approved);
  const pendingUsers = users.filter(u => !u.is_approved);
  const criticalEvents = events.filter(e => e.severity === 'critical');
  const filteredUsers = users.filter(u =>
    !search || u.username?.toLowerCase().includes(search.toLowerCase()) || u.full_name?.toLowerCase().includes(search.toLowerCase())
  );

  const mallStats = (mallId: string) => ({
    cameras: cameras.filter(c => c.mall_id === mallId).length,
    events: events.filter(e => e.mall_id === mallId).length,
    users: users.filter(u => u.mall_id === mallId).length,
  });

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
            <Code size={22} className="text-accent" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold text-white">Админ-панель</h1>
            <p className="text-slate-400 text-sm">Режим разработчика • Полный контроль системы</p>
          </div>
        </div>
        <Button variant="ghost" onClick={loadAll} loading={loading}>
          <RefreshCw size={16} />Обновить
        </Button>
      </div>

      {}
      <div className="flex flex-wrap gap-2 mb-6 border-b border-surface-300 pb-3">
        {[
          { k: 'overview', label: 'Обзор', icon: Activity },
          { k: 'malls', label: `ТРЦ (${malls.length})`, icon: Building2, badge: pendingMalls.length },
          { k: 'users', label: `Пользователи (${users.length})`, icon: UsersIcon, badge: pendingUsers.length },
          { k: 'events', label: 'Все события', icon: AlertTriangle, badge: criticalEvents.length },
          { k: 'audit', label: `Audit (${auditLogs.length})`, icon: FileText },
          { k: 'system', label: 'Система', icon: Server },
        ].map(t => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as Tab)}
            className={`relative px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all ${
              tab === t.k ? 'bg-accent text-white' : 'bg-surface-200 text-slate-400 hover:bg-surface-300'
            }`}
          >
            <t.icon size={14} />
            {t.label}
            {t.badge && t.badge > 0 ? (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-danger text-white text-xs">{t.badge}</span>
            ) : null}
          </button>
        ))}
      </div>

      {}
      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <StatCard title="Всего ТРЦ" value={malls.length} icon={<Building2 size={20} />} color="primary" subtitle={`${activeMalls.length} активных`} />
            <StatCard title="Пользователи" value={users.length} icon={<UsersIcon size={20} />} color="accent" subtitle={`${pendingUsers.length} на одобрении`} />
            <StatCard title="Камеры" value={cameras.length} icon={<Camera size={20} />} color="success" />
            <StatCard title="Инциденты" value={events.length} icon={<AlertTriangle size={20} />} color="accent" subtitle={`${criticalEvents.length} critical`} />
            <StatCard title="Ожидают одобрения" value={pendingMalls.length} icon={<Clock size={20} />} color="danger" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Building2 size={18} className="text-primary" />
                Топ ТРЦ по активности
              </h2>
              <div className="space-y-2">
                {activeMalls
                  .map(m => ({ ...m, stats: mallStats(m.id) }))
                  .sort((a, b) => (b.stats.events + b.stats.cameras) - (a.stats.events + a.stats.cameras))
                  .slice(0, 5)
                  .map(m => (
                    <div key={m.id} className="flex items-center justify-between p-3 rounded-lg bg-surface-200">
                      <div>
                        <p className="text-white font-medium text-sm">{m.name}</p>
                        <p className="text-xs text-slate-500">{m.city}</p>
                      </div>
                      <div className="flex gap-3 text-xs text-slate-400">
                        <span><Camera size={10} className="inline" /> {m.stats.cameras}</span>
                        <span><AlertTriangle size={10} className="inline" /> {m.stats.events}</span>
                        <span><UsersIcon size={10} className="inline" /> {m.stats.users}</span>
                      </div>
                    </div>
                  ))}
                {activeMalls.length === 0 && <p className="text-slate-500 text-sm text-center py-4">Нет активных ТРЦ</p>}
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Zap size={18} className="text-accent" />
                Последние события (все ТРЦ)
              </h2>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {events.slice(0, 10).map(e => {
                  const mall = malls.find(m => m.id === e.mall_id);
                  return (
                    <div key={e.id} className="flex items-start justify-between gap-2 p-3 rounded-lg bg-surface-200">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <SeverityBadge severity={e.severity} />
                          <span className="text-xs text-slate-500">{mall?.name || '—'}</span>
                        </div>
                        <p className="text-xs text-white truncate">{e.description}</p>
                        <p className="text-xs text-slate-600">{formatTimeAgo(e.created_at)}</p>
                      </div>
                    </div>
                  );
                })}
                {events.length === 0 && <p className="text-slate-500 text-sm text-center py-4">Событий нет</p>}
              </div>
            </Card>
          </div>
        </>
      )}

      {}
      {tab === 'malls' && (
        <>
          {pendingMalls.length > 0 && (
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                <Clock size={18} className="text-accent" />
                Ожидают одобрения ({pendingMalls.length})
              </h2>
              <div className="space-y-3">
                {pendingMalls.map(m => (
                  <Card key={m.id} className="!p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div>
                        <p className="text-white font-medium">{m.name}</p>
                        <p className="text-sm text-slate-400">{m.address} • {m.city}</p>
                        <p className="text-xs text-slate-500">Создан: {formatDate(m.created_at)}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button onClick={() => approveMall(m.id, true)} variant="success" size="sm"><Check size={14} />Одобрить</Button>
                        <Button onClick={() => deleteMall(m.id, m.name)} variant="danger" size="sm"><Trash2 size={14} />Удалить</Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Check size={18} className="text-success" />
            Активные ТРЦ ({activeMalls.length})
          </h2>
          <div className="space-y-3">
            {activeMalls.map(m => {
              const s = mallStats(m.id);
              return (
                <Card key={m.id} className="!p-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium">{m.name}</p>
                      <p className="text-sm text-slate-400">{m.address} • {m.city}</p>
                      <div className="flex gap-4 mt-2 text-xs text-slate-500">
                        <span><Camera size={12} className="inline mr-1" />{s.cameras} камер</span>
                        <span><AlertTriangle size={12} className="inline mr-1" />{s.events} событий</span>
                        <span><UsersIcon size={12} className="inline mr-1" />{s.users} юзеров</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={() => approveMall(m.id, false)} variant="ghost" size="sm"><X size={14} />Отключить</Button>
                      <Button onClick={() => deleteMall(m.id, m.name)} variant="danger" size="sm"><Trash2 size={14} /></Button>
                    </div>
                  </div>
                </Card>
              );
            })}
            {activeMalls.length === 0 && <p className="text-slate-500 text-center py-8">Нет активных ТРЦ</p>}
          </div>
        </>
      )}

      {}
      {tab === 'users' && (
        <>
          <div className="mb-4">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Поиск по username или имени..."
                className="w-full pl-10 pr-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white"
              />
            </div>
          </div>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-surface-300">
                    <th className="pb-2 pr-3">Юзер</th>
                    <th className="pb-2 pr-3">ТРЦ</th>
                    <th className="pb-2 pr-3">Роль</th>
                    <th className="pb-2 pr-3">Статус</th>
                    <th className="pb-2 pr-3">Создан</th>
                    <th className="pb-2">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(u => {
                    const mall = malls.find(m => m.id === u.mall_id);
                    return (
                      <tr key={u.id} className="border-b border-surface-300/50">
                        <td className="py-3 pr-3">
                          <p className="text-white font-medium">{u.full_name || u.username}</p>
                          <p className="text-xs text-slate-500">@{u.username}</p>
                        </td>
                        <td className="py-3 pr-3 text-slate-400">{mall?.name || '—'}</td>
                        <td className="py-3 pr-3">
                          <select
                            value={u.role || 'security'}
                            onChange={e => changeRole(u.id, e.target.value)}
                            className="px-2 py-1 rounded bg-surface-300 text-white text-xs"
                          >
                            <option value="security">security</option>
                            <option value="manager">manager</option>
                            <option value="admin">admin</option>
                            <option value="developer">developer</option>
                          </select>
                        </td>
                        <td className="py-3 pr-3">
                          {u.is_approved ? (
                            <span className="text-xs text-success">✅ Активен</span>
                          ) : (
                            <span className="text-xs text-danger">🔒 Заблокирован</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-xs text-slate-500">{formatDate(u.created_at)}</td>
                        <td className="py-3">
                          <div className="flex gap-1">
                            <button
                              onClick={() => toggleUser(u.id, u.is_approved)}
                              className="p-1.5 rounded bg-surface-300 hover:bg-primary/20 text-slate-300"
                              title={u.is_approved ? 'Заблокировать' : 'Активировать'}
                            >
                              {u.is_approved ? <UserX size={14} /> : <UserCheck size={14} />}
                            </button>
                            <button
                              onClick={() => deleteUser(u.id, u.username)}
                              className="p-1.5 rounded bg-surface-300 hover:bg-danger/20 text-danger"
                              title="Удалить"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredUsers.length === 0 && <p className="text-slate-500 text-center py-8">Нет пользователей</p>}
            </div>
          </Card>
        </>
      )}

      {}
      {tab === 'events' && (
        <>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <p className="text-slate-400 text-sm">{events.length} событий со всех ТРЦ</p>
            <Button variant="danger" size="sm" onClick={clearAllEvents}>
              <Trash2 size={14} />Очистить все инциденты
            </Button>
          </div>

          <div className="space-y-2">
            {events.map(e => {
              const mall = malls.find(m => m.id === e.mall_id);
              return (
                <Card key={e.id} className="!p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <TypeBadge type={e.type} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white">{e.description}</p>
                        <p className="text-xs text-slate-500">
                          {mall?.name || '—'} • {e.camera_name || e.zone || '—'} • {formatTimeAgo(e.created_at)}
                        </p>
                      </div>
                    </div>
                    <SeverityBadge severity={e.severity} />
                  </div>
                </Card>
              );
            })}
            {events.length === 0 && <p className="text-slate-500 text-center py-12">События отсутствуют</p>}
          </div>
        </>
      )}

      {}
      {tab === 'audit' && (
        <>
          <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
            <p className="text-slate-400 text-sm">Последние {auditLogs.length} действий пользователей</p>
            <p className="text-xs text-slate-500">Логи хранятся 90 дней</p>
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-surface-300">
                    <th className="pb-2 pr-3">Время</th>
                    <th className="pb-2 pr-3">Пользователь</th>
                    <th className="pb-2 pr-3">Действие</th>
                    <th className="pb-2 pr-3">Ресурс</th>
                    <th className="pb-2 pr-3">IP</th>
                    <th className="pb-2">Метаданные</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map(log => (
                    <tr key={log.id} className="border-b border-surface-300/50">
                      <td className="py-2 pr-3 text-xs text-slate-500 font-mono whitespace-nowrap">{formatTimeAgo(log.created_at)}</td>
                      <td className="py-2 pr-3 text-slate-200">{log.username || '—'}</td>
                      <td className="py-2 pr-3">
                        <code className="text-xs px-2 py-1 rounded bg-surface-300 text-accent">{log.action}</code>
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-400">{log.resource_type || '—'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500 font-mono">{log.ip_address || '—'}</td>
                      <td className="py-2 text-xs text-slate-500 font-mono max-w-xs truncate">
                        {log.metadata && Object.keys(log.metadata).length ? JSON.stringify(log.metadata) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {auditLogs.length === 0 && <p className="text-slate-500 text-center py-8">Логов пока нет</p>}
            </div>
          </Card>
        </>
      )}

      {}
      {tab === 'system' && (
        <>
          <div className="mb-6 flex items-center justify-between">
            <p className="text-slate-400 text-sm">Диагностика всех сервисов</p>
            <Button onClick={checkSystem} loading={loading}><Cpu size={16} />Запустить проверку</Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { key: 'supabase', label: 'Supabase DB', icon: Database, desc: 'Основная база данных' },
              { key: 'realtime', label: 'Supabase Realtime', icon: Zap, desc: 'Realtime подписки для дашборда' },
              { key: 'openai', label: 'OpenAI Vision', icon: Cpu, desc: 'AI-анализ кадров' },
              { key: 'telegram', label: 'Telegram', icon: Terminal, desc: 'Уведомления о событиях' },
            ].map(s => {
              const status = sysStatus?.[s.key];
              return (
                <Card key={s.key}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                        status?.ok ? 'bg-success/20' : status ? 'bg-danger/20' : 'bg-surface-300'
                      }`}>
                        <s.icon size={18} className={status?.ok ? 'text-success' : status ? 'text-danger' : 'text-slate-500'} />
                      </div>
                      <div>
                        <p className="text-white font-medium">{s.label}</p>
                        <p className="text-xs text-slate-500">{s.desc}</p>
                      </div>
                    </div>
                    {status && (
                      <span className={`text-xs px-2 py-1 rounded-full ${status.ok ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'}`}>
                        {status.ok ? 'OK' : 'FAIL'}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-400 font-mono">{status?.msg || 'Нажмите "Запустить проверку"'}</p>
                </Card>
              );
            })}
          </div>

          <Card className="mt-6">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <ShieldAlert size={18} className="text-danger" />
              Опасная зона
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-danger/5 border border-danger/20">
                <div>
                  <p className="text-white text-sm font-medium">Очистить все инциденты</p>
                  <p className="text-xs text-slate-500">Удалит ВСЕ события из ВСЕХ ТРЦ</p>
                </div>
                <Button variant="danger" size="sm" onClick={clearAllEvents}><Trash2 size={14} />Очистить</Button>
              </div>
            </div>
          </Card>

          <Card className="mt-4">
            <h3 className="text-white font-semibold mb-3">Информация о системе</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-500 text-xs">Версия</p>
                <p className="text-white font-mono">SafeZone v2.3</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Администратор</p>
                <p className="text-white font-mono">{profile?.username} ({profile?.role})</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Активных ТРЦ</p>
                <p className="text-white font-mono">{activeMalls.length} / {malls.length}</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs">Активных юзеров</p>
                <p className="text-white font-mono">{users.filter(u => u.is_approved).length} / {users.length}</p>
              </div>
            </div>
          </Card>
        </>
      )}
    </DashboardLayout>
  );
}
