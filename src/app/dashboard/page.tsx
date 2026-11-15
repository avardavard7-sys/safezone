'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { StatCard, Card } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Camera, AlertTriangle, Users, Store, Shield, Eye, MapPin, Activity } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SeverityBadge, TypeBadge, StatusBadge } from '@/components/ui/Badge';
import { formatTimeAgo } from '@/lib/utils';
import toast from 'react-hot-toast';
import Link from 'next/link';

export default function DashboardPage() {
  const { mall, profile } = useAuth();
  const [stats, setStats] = useState({ cameras: 0, events: 0, tenants: 0, zones: 0, critical: 0, visitors: 0, violations: 0 });
  const [recentEvents, setRecentEvents] = useState<any[]>([]);

  useEffect(() => {
    if (!mall) return;
    const sb = createClient();
    const load = async () => {
      const [cam, evt, ten, zon, vio] = await Promise.all([
        sb.from('cameras').select('id', { count: 'exact' }).eq('mall_id', mall.id),
        sb.from('events').select('id', { count: 'exact' }).eq('mall_id', mall.id),
        sb.from('tenants').select('id', { count: 'exact' }).eq('mall_id', mall.id),
        sb.from('zones').select('id', { count: 'exact' }).eq('mall_id', mall.id),
        sb.from('violations').select('id', { count: 'exact' }).eq('mall_id', mall.id),
      ]);
      const { count: crit } = await sb.from('events').select('id', { count: 'exact' }).eq('mall_id', mall.id).eq('severity', 'critical').eq('status', 'new');

      const { data: zonesData } = await sb.from('zones').select('current_visitors').eq('mall_id', mall.id);
      const totalVisitors = zonesData?.reduce((sum, z) => sum + (z.current_visitors || 0), 0) || 0;

      setStats({
        cameras: cam.count || 0,
        events: evt.count || 0,
        tenants: ten.count || 0,
        zones: zon.count || 0,
        critical: crit || 0,
        violations: vio.count || 0,
        visitors: totalVisitors,
      });
      const { data: events } = await sb.from('events').select('*').eq('mall_id', mall.id).order('created_at', { ascending: false }).limit(5);
      setRecentEvents(events || []);
    };
    load();
    const channel = sb.channel('dashboard-events').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events', filter: `mall_id=eq.${mall.id}` }, (payload: any) => {
      setRecentEvents(prev => [payload.new, ...prev].slice(0, 5));
      setStats(prev => ({ ...prev, events: prev.events + 1 }));
      if (payload.new.severity === 'critical') {
        toast.error(`🚨 ${payload.new.description}`, { duration: 8000 });
      } else if (payload.new.severity === 'high') {
        toast(`⚠️ ${payload.new.description}`, { duration: 5000 });
      }
    }).subscribe();
    return () => { sb.removeChannel(channel); };
  }, [mall]);

  const handlePanic = async () => {
    if (!mall) return;
    const sb = createClient();
    await sb.from('events').insert({
      mall_id: mall.id,
      type: 'suspicious',
      severity: 'critical',
      description: '🚨 ТРЕВОЖНАЯ КНОПКА АКТИВИРОВАНА',
      zone: 'Весь ТРЦ',
      status: 'new',
    });
    toast.error('🚨 ТРЕВОГА ОТПРАВЛЕНА!', { duration: 5000 });
  };

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">{mall?.name || 'SafeZone'}</h1>
          <p className="text-slate-400 text-sm">Центр управления безопасностью</p>
        </div>
        <div className="flex gap-3">
          <Link href="/dashboard/monitoring"><Button variant="primary"><Eye size={18} />Мониторинг</Button></Link>
          <Button variant="danger" onClick={handlePanic} className="glow-danger"><Shield size={18} />ТРЕВОГА</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4 mb-6">
        <StatCard title="Камеры" value={stats.cameras} icon={<Camera size={20} />} color="primary" />
        <StatCard title="Инциденты" value={stats.events} icon={<AlertTriangle size={20} />} color="accent" />
        <StatCard title="Критичные" value={stats.critical} icon={<Shield size={20} />} color="danger" subtitle="Требуют реакции" />
        <StatCard title="Арендаторы" value={stats.tenants} icon={<Store size={20} />} color="success" />
        <StatCard title="Зоны" value={stats.zones} icon={<MapPin size={20} />} color="primary" />
        <StatCard title="Нарушения" value={stats.violations} icon={<Activity size={20} />} color="accent" />
        <StatCard title="Посетители" value={stats.visitors} icon={<Users size={20} />} color="success" subtitle="В данный момент" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-display font-semibold text-white">Последние инциденты</h2>
            <Link href="/dashboard/events" className="text-sm text-primary hover:text-primary-light">Все →</Link>
          </div>
          {recentEvents.length === 0 ? (
            <div className="text-center py-8">
              <AlertTriangle className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">Инцидентов нет — всё спокойно</p>
            </div>
          ) : (
            <div className="space-y-3">{recentEvents.map(e => (
              <div key={e.id} className="flex items-center justify-between p-3 rounded-xl bg-surface-200/50 hover:bg-surface-200 transition-all">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <TypeBadge type={e.type} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{e.description}</p>
                    <p className="text-xs text-slate-500">{e.camera_name || e.zone} • {formatTimeAgo(e.created_at)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <SeverityBadge severity={e.severity} />
                  <StatusBadge status={e.status} />
                </div>
              </div>
            ))}</div>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-display font-semibold text-white mb-4">Быстрые действия</h2>
          <div className="space-y-3">
            <Link href="/dashboard/cameras" className="block p-4 rounded-xl bg-surface-200 hover:bg-surface-300 transition-all">
              <div className="flex items-center gap-3"><Camera size={20} className="text-primary" /><div><p className="text-sm text-white font-medium">Управление камерами</p><p className="text-xs text-slate-500">Добавить/настроить</p></div></div>
            </Link>
            <Link href="/dashboard/monitoring" className="block p-4 rounded-xl bg-surface-200 hover:bg-surface-300 transition-all">
              <div className="flex items-center gap-3"><Eye size={20} className="text-accent" /><div><p className="text-sm text-white font-medium">Живой мониторинг</p><p className="text-xs text-slate-500">Камеры в реальном времени</p></div></div>
            </Link>
            <Link href="/dashboard/tenants" className="block p-4 rounded-xl bg-surface-200 hover:bg-surface-300 transition-all">
              <div className="flex items-center gap-3"><Store size={20} className="text-success" /><div><p className="text-sm text-white font-medium">Арендаторы</p><p className="text-xs text-slate-500">Контроль и штрафы</p></div></div>
            </Link>
            <Link href="/dashboard/analytics" className="block p-4 rounded-xl bg-surface-200 hover:bg-surface-300 transition-all">
              <div className="flex items-center gap-3"><Activity size={20} className="text-primary" /><div><p className="text-sm text-white font-medium">Аналитика</p><p className="text-xs text-slate-500">Графики и отчёты</p></div></div>
            </Link>
          </div>
        </Card>
      </div>
    </DashboardLayout>
  );
}
