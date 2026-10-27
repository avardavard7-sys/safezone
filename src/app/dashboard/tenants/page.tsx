'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Plus, Store, Trash2, Edit2, Phone, Mail } from 'lucide-react';
import toast from 'react-hot-toast';

const cats: Record<string, string> = {
  retail: '🛍️ Магазин',
  food: '🍔 Еда',
  entertainment: '🎮 Развлечения',
  services: '💇 Услуги',
  supermarket: '🛒 Супермаркет',
  cinema: '🎬 Кинотеатр',
  kids: '🧒 Детский',
};

export default function TenantsPage() {
  const { mall } = useAuth();
  const [tenants, setTenants] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({ name: '', shop_number: '', floor: '1', category: 'retail', contact_person: '', phone: '', email: '', work_start: '10:00', work_end: '22:00' });

  useEffect(() => { if (mall) load(); }, [mall]);

  const load = async () => {
    const sb = createClient();
    const { data } = await sb.from('tenants').select('*').eq('mall_id', mall?.id).order('name');
    setTenants(data || []);
  };

  const reset = () => {
    setForm({ name: '', shop_number: '', floor: '1', category: 'retail', contact_person: '', phone: '', email: '', work_start: '10:00', work_end: '22:00' });
    setEditing(null);
    setShowAdd(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const sb = createClient();
    const data = { mall_id: mall?.id, ...form, floor: parseInt(form.floor) };
    if (editing) {
      await sb.from('tenants').update(data).eq('id', editing.id);
      toast.success('Обновлён');
    } else {
      await sb.from('tenants').insert(data);
      toast.success('Арендатор добавлен');
    }
    reset();
    load();
  };

  const edit = (t: any) => {
    setEditing(t);
    setForm({
      name: t.name,
      shop_number: t.shop_number || '',
      floor: String(t.floor),
      category: t.category,
      contact_person: t.contact_person || '',
      phone: t.phone || '',
      email: t.email || '',
      work_start: t.work_start?.slice(0, 5) || '10:00',
      work_end: t.work_end?.slice(0, 5) || '22:00',
    });
    setShowAdd(true);
  };

  const del = async (id: string) => {
    if (!confirm('Удалить арендатора?')) return;
    const sb = createClient();
    await sb.from('tenants').delete().eq('id', id);
    load();
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Арендаторы</h1>
          <p className="text-slate-400 text-sm">{tenants.length} арендаторов</p>
        </div>
        <Button onClick={() => { reset(); setShowAdd(true); }}><Plus size={16} />Добавить</Button>
      </div>

      {showAdd && (
        <Card className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">{editing ? 'Редактировать' : 'Новый арендатор'}</h2>
          <form onSubmit={save} className="grid grid-cols-2 gap-4">
            <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Название магазина" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" required />
            <input value={form.shop_number} onChange={e => setForm(p => ({ ...p, shop_number: e.target.value }))} placeholder="Номер помещения" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white">
              {Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input value={form.floor} onChange={e => setForm(p => ({ ...p, floor: e.target.value }))} placeholder="Этаж" type="number" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            <input value={form.contact_person} onChange={e => setForm(p => ({ ...p, contact_person: e.target.value }))} placeholder="Контактное лицо" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            <input value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} placeholder="Телефон" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="Email" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white col-span-2" />
            <input value={form.work_start} onChange={e => setForm(p => ({ ...p, work_start: e.target.value }))} type="time" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            <input value={form.work_end} onChange={e => setForm(p => ({ ...p, work_end: e.target.value }))} type="time" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            <div className="col-span-2 flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={reset}>Отмена</Button>
              <Button type="submit">Сохранить</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {tenants.map(t => (
          <Card key={t.id}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <Store size={18} className="text-primary flex-shrink-0" />
                <h3 className="font-medium text-white truncate">{t.name}</h3>
              </div>
              <span className="text-xs bg-surface-200 px-2 py-1 rounded-full text-slate-400 flex-shrink-0">{cats[t.category]}</span>
            </div>
            <div className="text-sm text-slate-400 space-y-1 mb-3">
              <p>Пом. {t.shop_number || '—'} • Этаж {t.floor}</p>
              {t.contact_person && <p>{t.contact_person}</p>}
              {t.phone && <p className="flex items-center gap-1.5"><Phone size={12} />{t.phone}</p>}
              {t.email && <p className="flex items-center gap-1.5"><Mail size={12} />{t.email}</p>}
              <p className="text-xs">Режим: {t.work_start?.slice(0, 5)}—{t.work_end?.slice(0, 5)}</p>
              {t.violations_count > 0 && <p className="text-orange-400 text-xs">Нарушений: {t.violations_count} • Штрафов: {t.total_fines || 0} ₸</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={() => edit(t)} className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300 flex items-center justify-center gap-1">
                <Edit2 size={12} />Изменить
              </button>
              <button onClick={() => del(t.id)} className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-danger/10 text-danger hover:bg-danger/20 flex items-center justify-center gap-1">
                <Trash2 size={12} />Удалить
              </button>
            </div>
          </Card>
        ))}
      </div>

      {tenants.length === 0 && !showAdd && (
        <Card className="text-center py-12">
          <Store className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">Арендаторы не добавлены</p>
        </Card>
      )}
    </DashboardLayout>
  );
}
