'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { MapPin, Users, Camera, Plus, Edit2, Trash2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

const ZONE_TYPES = [
  { value: 'entrance', label: '🚪 Вход' },
  { value: 'corridor', label: '🏢 Коридор' },
  { value: 'parking', label: '🅿️ Парковка' },
  { value: 'food_court', label: '🍔 Фуд-корт' },
  { value: 'escalator', label: '⬆️ Эскалатор' },
  { value: 'loading', label: '📦 Разгрузка' },
  { value: 'restroom', label: '🚻 Туалет' },
  { value: 'kids', label: '🧒 Детский парк' },
  { value: 'cinema', label: '🎬 Кинотеатр' },
  { value: 'shop', label: '🛍️ Магазин' },
  { value: 'other', label: '📍 Другое' },
];

const typeLabels: Record<string, string> = Object.fromEntries(ZONE_TYPES.map(z => [z.value, z.label]));

const Field = ({ label, hint, children }: any) => (
  <div>
    <label className="block text-xs text-slate-400 mb-1">{label}</label>
    {children}
    {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
  </div>
);

export default function ZonesPage() {
  const { mall } = useAuth();
  const [zones, setZones] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'entrance', floor: '1' });

  useEffect(() => { if (mall) loadZones(); }, [mall]);

  const loadZones = async () => {
    if (!mall) return;
    const sb = createClient();
    const { data } = await sb.from('zones').select('*').eq('mall_id', mall.id).order('floor').order('name');
    setZones(data || []);
  };

  const resetForm = () => {
    setForm({ name: '', type: 'entrance', floor: '1' });
    setEditing(null);
    setShowForm(false);
  };

  const saveZone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mall) return;
    setLoading(true);
    const sb = createClient();
    const data = {
      mall_id: mall.id,
      name: form.name,
      type: form.type,
      floor: parseInt(form.floor) || 1,
    };
    try {
      if (editing) {
        const { error } = await sb.from('zones').update(data).eq('id', editing.id);
        if (error) throw error;
        toast.success('Зона обновлена');
      } else {
        const { error } = await sb.from('zones').insert(data);
        if (error) throw error;
        toast.success('Зона добавлена');
      }
      resetForm();
      loadZones();
    } catch (e: any) {
      toast.error('Ошибка: ' + (e.message || e));
    }
    setLoading(false);
  };

  const editZone = (z: any) => {
    setEditing(z);
    setForm({ name: z.name || '', type: z.type || 'entrance', floor: String(z.floor || 1) });
    setShowForm(true);
  };

  const deleteZone = async (id: string, name: string) => {
    if (!confirm(`Удалить зону "${name}"? Камеры в этой зоне останутся, но потеряют привязку.`)) return;
    const sb = createClient();
    const { error } = await sb.from('zones').delete().eq('id', id);
    if (error) {
      toast.error('Ошибка: ' + error.message);
      return;
    }
    toast.success('Зона удалена');
    loadZones();
  };

  const byFloor = zones.reduce((acc: Record<number, any[]>, z) => {
    if (!acc[z.floor]) acc[z.floor] = [];
    acc[z.floor].push(z);
    return acc;
  }, {});

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Зоны ТРЦ</h1>
          <p className="text-slate-400 text-sm">{zones.length} зон • {mall?.name}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={loadZones}><RefreshCw size={16} />Обновить</Button>
          <Button onClick={() => { resetForm(); setShowForm(true); }}><Plus size={16} />Добавить зону</Button>
        </div>
      </div>

      {showForm && (
        <Card className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">{editing ? 'Редактировать зону' : 'Новая зона'}</h2>
          <form onSubmit={saveZone} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Название" hint="Например: Главный вход, Фуд-корт 2 этаж">
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="Главный вход" required
                className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            </Field>

            <Field label="Тип зоны">
              <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white">
                {ZONE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>

            <Field label="Этаж">
              <input value={form.floor} onChange={e => setForm(p => ({ ...p, floor: e.target.value }))}
                type="number" min="-2" max="20"
                className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            </Field>

            <div className="md:col-span-3 flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={resetForm}>Отмена</Button>
              <Button type="submit" loading={loading}>{editing ? 'Сохранить' : 'Добавить'}</Button>
            </div>
          </form>
        </Card>
      )}

      {Object.keys(byFloor).sort((a, b) => Number(a) - Number(b)).map(floor => (
        <div key={floor} className="mb-6">
          <h2 className="text-lg font-display font-semibold text-white mb-3 flex items-center gap-2">
            <span className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary">{floor}</span>
            Этаж {floor}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {byFloor[Number(floor)].map(z => (
              <Card key={z.id}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MapPin size={18} className="text-primary" />
                    <h3 className="font-medium text-white">{z.name}</h3>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => editZone(z)}
                      className="p-1.5 rounded bg-surface-200 hover:bg-surface-300 text-slate-300"
                      title="Изменить">
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => deleteZone(z.id, z.name)}
                      className="p-1.5 rounded bg-danger/10 hover:bg-danger/20 text-danger"
                      title="Удалить">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="text-sm text-slate-400 space-y-1.5">
                  <p>Тип: {typeLabels[z.type] || z.type}</p>
                  <div className="flex items-center justify-between pt-2 border-t border-surface-300">
                    <div className="flex items-center gap-1.5">
                      <Camera size={14} className="text-slate-500" />
                      <span className="text-xs">{z.cameras_count || 0} камер</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Users size={14} className="text-slate-500" />
                      <span className="text-xs">{z.current_visitors || 0} посетителей</span>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ))}

      {zones.length === 0 && !showForm && (
        <Card className="text-center py-12">
          <MapPin className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400 mb-3">Зоны не созданы</p>
          <Button onClick={() => setShowForm(true)}><Plus size={16} />Добавить первую зону</Button>
        </Card>
      )}
    </DashboardLayout>
  );
}
