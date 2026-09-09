'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, StatCard } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, Legend } from 'recharts';
import { TrendingUp, TrendingDown, AlertTriangle, MapPin, Clock, Activity } from 'lucide-react';

const COLORS = ['#6366F1', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

export default function AnalyticsPage() {
  const { mall } = useAuth();
  const [data, setData] = useState<any>({
    byType: [], byHour: [], bySeverity: [], byZone: [], topZones: [], totalEvents: 0, criticalEvents: 0, avgPerDay: 0,
  });

  useEffect(() => { if (mall) load(); }, [mall]);

  const load = async () => {
    const sb = createClient();
    const { data: events } = await sb.from('events').select('*').eq('mall_id', mall?.id).limit(1000);
    if (!events) return;

    const byType = events.reduce((acc: any, e: any) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});
    const byTypeArr = Object.entries(byType).map(([name, value]) => ({ name, value }));

    const bySeverity = events.reduce((acc: any, e: any) => {
      acc[e.severity] = (acc[e.severity] || 0) + 1;
      return acc;
    }, {});
    const bySeverityArr = Object.entries(bySeverity).map(([name, value]) => ({ name, value }));

    const byHour = Array(24).fill(0);
    events.forEach((e: any) => {
      const h = new Date(e.created_at).getHours();
      byHour[h]++;
    });
    const byHourArr = byHour.map((count, h) => ({ hour: `${h}:00`, events: count }));

    const byZone = events.reduce((acc: any, e: any) => {
      const z = e.zone || 'Не указана';
      acc[z] = (acc[z] || 0) + 1;
      return acc;
    }, {});
    const byZoneArr = Object.entries(byZone).map(([name, value]) => ({ name, value })).sort((a: any, b: any) => b.value - a.value).slice(0, 5);

    setData({
      byType: byTypeArr,
      byHour: byHourArr,
      bySeverity: bySeverityArr,
      byZone: byZoneArr,
      topZones: byZoneArr,
      totalEvents: events.length,
      criticalEvents: events.filter((e: any) => e.severity === 'critical').length,
      avgPerDay: Math.round(events.length / 7),
    });
  };

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-white">Аналитика</h1>
        <p className="text-slate-400 text-sm">Статистика инцидентов и тенденции</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <StatCard title="Всего событий" value={data.totalEvents} icon={<Activity size={20} />} color="primary" />
        <StatCard title="Критичных" value={data.criticalEvents} icon={<AlertTriangle size={20} />} color="danger" />
        <StatCard title="В среднем/день" value={data.avgPerDay} icon={<TrendingUp size={20} />} color="accent" />
        <StatCard title="Горячих зон" value={data.topZones.length} icon={<MapPin size={20} />} color="success" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <Card>
          <h2 className="text-lg font-semibold text-white mb-4">По типу инцидентов</h2>
          {data.byType.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.byType}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A3148" />
                <XAxis dataKey="name" stroke="#64748B" />
                <YAxis stroke="#64748B" />
                <Tooltip contentStyle={{ backgroundColor: '#1C2236', border: '1px solid #2A3148', borderRadius: '8px' }} />
                <Bar dataKey="value" fill="#6366F1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="text-slate-500 text-center py-12 text-sm">Нет данных</p>}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-white mb-4">По уровню опасности</h2>
          {data.bySeverity.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={data.bySeverity} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                  {data.bySeverity.map((entry: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: '#1C2236', border: '1px solid #2A3148', borderRadius: '8px' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="text-slate-500 text-center py-12 text-sm">Нет данных</p>}
        </Card>
      </div>

      <Card className="mb-6">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Clock size={20} className="text-primary" />
          Активность по часам
        </h2>
        {data.byHour.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.byHour}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A3148" />
              <XAxis dataKey="hour" stroke="#64748B" />
              <YAxis stroke="#64748B" />
              <Tooltip contentStyle={{ backgroundColor: '#1C2236', border: '1px solid #2A3148', borderRadius: '8px' }} />
              <Line type="monotone" dataKey="events" stroke="#F59E0B" strokeWidth={2} dot={{ fill: '#F59E0B' }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="text-slate-500 text-center py-12 text-sm">Нет данных</p>}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <MapPin size={20} className="text-accent" />
          Топ горячих зон
        </h2>
        {data.topZones.length > 0 ? (
          <div className="space-y-3">
            {data.topZones.map((z: any, i: number) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">{i + 1}</div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm text-white">{z.name}</p>
                    <p className="text-sm font-bold text-accent">{String(z.value)}</p>
                  </div>
                  <div className="h-2 bg-surface-200 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-primary to-accent rounded-full" style={{ width: `${(Number(z.value) / Number(data.topZones[0].value)) * 100}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="text-slate-500 text-center py-8 text-sm">Нет данных</p>}
      </Card>
    </DashboardLayout>
  );
}
