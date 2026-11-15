'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { FileWarning, Download, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDate } from '@/lib/utils';

const MRP_2026 = 3932;

const violationTypes: Record<string, { label: string; fine: number }> = {
  schedule: { label: 'Нарушение графика работы', fine: 2 },
  smoking: { label: 'Курение в неположенном месте', fine: 10 },
  food: { label: 'Еда вне фуд-корта', fine: 2 },
  garbage: { label: 'Неправильная утилизация мусора', fine: 2 },
  obstacle: { label: 'Создание препятствий', fine: 10 },
  uniform: { label: 'Нарушение формы одежды', fine: 2 },
  storage: { label: 'Складирование в проходах', fine: 10 },
  damage: { label: 'Причинение ущерба имуществу', fine: 20 },
};

export default function ViolationsPage() {
  const { mall } = useAuth();
  const [violations, setViolations] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ tenant_id: '', type: 'schedule', description: '', fine_mrp: '2' });

  useEffect(() => { if (mall) { load(); loadTenants(); } }, [mall]);

  const load = async () => {
    const sb = createClient();
    const { data } = await sb.from('violations').select('*').eq('mall_id', mall?.id).order('created_at', { ascending: false });
    setViolations(data || []);
  };

  const loadTenants = async () => {
    const sb = createClient();
    const { data } = await sb.from('tenants').select('*').eq('mall_id', mall?.id).order('name');
    setTenants(data || []);
  };

  const generateActNumber = () => {
    const d = new Date();
    return `АКТ-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  };

  const addViolation = async (e: React.FormEvent) => {
    e.preventDefault();
    const sb = createClient();
    const tenant = tenants.find(t => t.id === form.tenant_id);
    const fineMrp = parseInt(form.fine_mrp);
    const fineAmount = fineMrp * MRP_2026;
    const actNumber = generateActNumber();
    await sb.from('violations').insert({
      mall_id: mall?.id,
      tenant_id: form.tenant_id,
      tenant_name: tenant?.name,
      type: violationTypes[form.type]?.label || form.type,
      description: form.description,
      fine_mrp: fineMrp,
      fine_amount: fineAmount,
      act_number: actNumber,
      status: 'pending',
    });

    if (tenant) {
      await sb.from('tenants').update({
        violations_count: (tenant.violations_count || 0) + 1,
        total_fines: (tenant.total_fines || 0) + fineAmount,
      }).eq('id', tenant.id);
    }
    toast.success(`Акт ${actNumber} создан`);
    setShowAdd(false);
    load();
  };

  const downloadAct = (v: any) => {
    const content = `АКТ О НАРУШЕНИИ ПРАВИЛ ТРЦ
Номер: ${v.act_number}
Дата: ${formatDate(v.created_at)}

АРЕНДАТОР: ${v.tenant_name}
ТИП НАРУШЕНИЯ: ${v.type}
ОПИСАНИЕ: ${v.description}

ШТРАФ: ${v.fine_mrp} МРП (${v.fine_amount?.toLocaleString('ru-RU')} ₸)
СТАТУС: ${v.status}

Согласно правилам ТРЦ (Приложение №6 к договору аренды):
- 2 МРП — за первичное нарушение
- 10 МРП — за вторичное нарушение
- 20 МРП — за нарушение в третий и каждый последующий раз

Служба безопасности ТРЦ
${mall?.name}`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${v.act_number}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateStatus = async (id: string, status: string) => {
    const sb = createClient();
    await sb.from('violations').update({ status }).eq('id', id);
    load();
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Акты нарушений</h1>
          <p className="text-slate-400 text-sm">{violations.length} актов</p>
        </div>
        <Button onClick={() => setShowAdd(true)}><Plus size={16} />Создать акт</Button>
      </div>

      {showAdd && (
        <Card className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">Новый акт нарушения</h2>
          <form onSubmit={addViolation} className="grid grid-cols-2 gap-4">
            <select value={form.tenant_id} onChange={e => setForm(p => ({ ...p, tenant_id: e.target.value }))} className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white col-span-2" required>
              <option value="">Выберите арендатора</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name} (пом. {t.shop_number})</option>)}
            </select>
            <select value={form.type} onChange={e => {
              const fineMrp = violationTypes[e.target.value]?.fine || 2;
              setForm(p => ({ ...p, type: e.target.value, fine_mrp: String(fineMrp) }));
            }} className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white">
              {Object.entries(violationTypes).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input value={form.fine_mrp} onChange={e => setForm(p => ({ ...p, fine_mrp: e.target.value }))} placeholder="Штраф в МРП" type="number" className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" required />
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Описание нарушения" rows={3} className="px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white col-span-2" required />
            <div className="col-span-2 flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={() => setShowAdd(false)}>Отмена</Button>
              <Button type="submit">Создать акт</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-3">
        {violations.map(v => (
          <Card key={v.id} className="!p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-primary/10 text-primary">{v.act_number}</span>
                  <StatusBadge status={v.status} />
                </div>
                <p className="text-white font-medium">{v.tenant_name}</p>
                <p className="text-sm text-slate-400 mt-1">{v.type}</p>
                <p className="text-xs text-slate-500 mt-1">{v.description}</p>
                <p className="text-xs text-slate-600 mt-1">{formatDate(v.created_at)}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="text-right">
                  <p className="text-sm text-slate-500">Штраф</p>
                  <p className="text-lg font-display font-bold text-accent">{v.fine_mrp} МРП</p>
                  <p className="text-xs text-slate-500">{v.fine_amount?.toLocaleString('ru-RU')} ₸</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => downloadAct(v)} className="text-xs px-3 py-1.5 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300 flex items-center gap-1">
                    <Download size={12} />Акт
                  </button>
                  {v.status === 'pending' && (
                    <>
                      <button onClick={() => updateStatus(v.id, 'confirmed')} className="text-xs px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30">Подтвердить</button>
                      <button onClick={() => updateStatus(v.id, 'cancelled')} className="text-xs px-3 py-1.5 rounded-lg bg-slate-500/20 text-slate-400 hover:bg-slate-500/30">Отменить</button>
                    </>
                  )}
                  {v.status === 'confirmed' && (
                    <button onClick={() => updateStatus(v.id, 'paid')} className="text-xs px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30">Оплачен</button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {violations.length === 0 && !showAdd && (
        <Card className="text-center py-12">
          <FileWarning className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">Актов нарушений нет</p>
        </Card>
      )}
    </DashboardLayout>
  );
}
