'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SeverityBadge, TypeBadge, StatusBadge } from '@/components/ui/Badge';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, Check, X, RefreshCw } from 'lucide-react';

export default function EventsPage() {
  const { mall } = useAuth();
  const [events, setEvents] = useState<any[]>([]);
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  useEffect(() => { if (mall) loadEvents(); }, [mall, filter, typeFilter]);

  const loadEvents = async () => {
    const sb = createClient();
    let q = sb.from('events').select('*').eq('mall_id', mall?.id).order('created_at', { ascending: false }).limit(100);
    if (filter !== 'all') q = q.eq('severity', filter);
    if (typeFilter !== 'all') q = q.eq('type', typeFilter);
    const { data } = await q;
    setEvents(data || []);
  };

  const updateStatus = async (id: string, status: string) => {
    const sb = createClient();
    await sb.from('events').update({ status }).eq('id', id);
    loadEvents();
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Инциденты</h1>
          <p className="text-slate-400 text-sm">{events.length} событий</p>
        </div>
        <Button variant="ghost" onClick={loadEvents}><RefreshCw size={16} />Обновить</Button>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        <div className="flex gap-1.5">
          {['all', 'critical', 'high', 'medium', 'low'].map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filter === f ? 'bg-primary text-white' : 'bg-surface-200 text-slate-400 hover:bg-surface-300'}`}>
              {f === 'all' ? 'Все уровни' : f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {events.map(e => (
          <Card key={e.id} className="!p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <TypeBadge type={e.type} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">{e.description}</p>
                  <p className="text-xs text-slate-500">{e.camera_name || e.zone || 'Неизвестно'} • Этаж {e.floor || '—'} • {formatDate(e.created_at)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <SeverityBadge severity={e.severity} />
                <StatusBadge status={e.status} />
                {e.status === 'new' && (
                  <>
                    <button onClick={() => updateStatus(e.id, 'resolved')} className="p-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30" title="Решено">
                      <Check size={14} />
                    </button>
                    <button onClick={() => updateStatus(e.id, 'false_alarm')} className="p-1.5 rounded-lg bg-slate-500/20 text-slate-400 hover:bg-slate-500/30" title="Ложная тревога">
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {events.length === 0 && (
        <Card className="text-center py-12">
          <AlertTriangle className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">Инцидентов нет</p>
        </Card>
      )}
    </DashboardLayout>
  );
}
