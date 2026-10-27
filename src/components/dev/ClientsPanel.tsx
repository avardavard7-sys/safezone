'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { BUSINESS_TYPES, type BusinessType } from '@/lib/business';
import { Copy, KeyRound, RefreshCw, SlidersHorizontal, UserPlus } from 'lucide-react';
import ClientFeatures from './ClientFeatures';
import toast from 'react-hot-toast';

type Client = { mall_id: string; name: string; city: string | null; business_type: BusinessType; user_id: string | null; login: string | null; full_name: string | null; site_subnets: string[] };
type Issued = { login: string; password: string; object: string };

const LOGIN_URL = typeof window !== 'undefined' ? `${window.location.origin}/login` : '/login';

function genPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, n => abc[n % abc.length]).join('');
}

const typeLabel = (t: string) => BUSINESS_TYPES.find(x => x.key === t)?.label || t;

export default function ClientsPanel() {
  const sb = createClient();
  const [type, setType] = useState<BusinessType>('shop');
  const [form, setForm] = useState({ object: '', city: '', address: '', fullName: '', login: '', password: genPassword() });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [posKey, setPosKey] = useState<{ name: string; key: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const u = (k: keyof typeof form, v: string) => setForm(p => ({ ...p, [k]: v }));

  async function load() {
    const [m, p] = await Promise.all([
      sb.from('malls').select('id, name, city, business_type, site_subnets').order('created_at', { ascending: false }),
      sb.from('profiles').select('id, username, full_name, mall_id, role').eq('role', 'admin'),
    ]);
    const admins = new Map((p.data || []).map((x: any) => [x.mall_id, x]));
    setClients((m.data || []).map((x: any) => {
      const a: any = admins.get(x.id);
      return { mall_id: x.id, name: x.name, city: x.city, business_type: x.business_type, user_id: a?.id || null, login: a?.username || null, full_name: a?.full_name || null, site_subnets: x.site_subnets || [] };
    }));
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setBusy(true);
    const { data, error } = await sb.rpc('dev_create_client', {
      p_business_type: type, p_object_name: form.object, p_city: form.city, p_address: form.address,
      p_full_name: form.fullName, p_login: form.login, p_password: form.password,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setIssued({ login: (data as any).login, password: form.password, object: form.object });
    setForm({ object: '', city: '', address: '', fullName: '', login: '', password: genPassword() });
    load();
  }

  async function reset(c: Client) {
    if (!c.user_id) return;
    const pwd = genPassword();
    if (!confirm(`Выдать новый пароль для «${c.login}»? Старый перестанет работать.`)) return;
    const { error } = await sb.rpc('dev_reset_password', { p_user: c.user_id, p_password: pwd });
    if (error) { toast.error(error.message); return; }
    setIssued({ login: c.login!, password: pwd, object: c.name });
  }

  async function newPosKey(c: Client) {
    if (!confirm(`Выдать ключ кассовой системы для «${c.name}»? Старый перестанет работать.`)) return;
    const { data, error } = await sb.rpc('dev_new_pos_key', { p_mall: c.mall_id });
    if (error) { toast.error(error.message); return; }
    setPosKey({ name: c.name, key: data as string });
  }

  async function saveNets(c: Client, value: string) {
    const { data, error } = await sb.rpc('dev_set_site_subnets', { p_mall: c.mall_id, p_nets: value });
    if (error) { toast.error(error.message); return; }
    toast.success(`Сеть объекта «${c.name}»: ${((data as string[]) || []).map(n => n + '.x').join(', ') || 'не задана'}`);
    load();
  }

  const message = issued
    ? `Доступ к Aura SafeZone — ${issued.object}\nВход: ${LOGIN_URL}\nЛогин: ${issued.login}\nПароль: ${issued.password}\n\nПароль показан один раз — сохраните его.`
    : '';

  const field = 'w-full bg-surface-200 border border-surface-300 rounded-lg px-3 py-2 text-white';

  return (
    <div className="space-y-6">
      {posKey && (
        <Card className="border border-ice/40 space-y-3">
          <div className="text-white font-semibold">Ключ кассовой системы — {posKey.name}</div>
          <pre className="bg-surface-200 rounded-lg p-3 text-xs text-slate-200 whitespace-pre-wrap">{`Адрес:  ${typeof window !== 'undefined' ? window.location.origin : ''}/api/pos
Метод:  POST
Заголовок:  X-Pos-Key: ${posKey.key}
Тело:  {"events":[{"kind":"sale","receipt_id":"123","amount":1500,"at":"2026-10-27T15:04:00+05:00"}]}
Виды:  sale — продажа, return — возврат, void — отмена, drawer_open — открытие ящика`}</pre>
          <div className="flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(posKey.key); toast.success('Ключ скопирован'); }} className="px-4 py-2 rounded-lg bg-primary text-white">Скопировать ключ</button>
            <button onClick={() => setPosKey(null)} className="px-4 py-2 rounded-lg bg-surface-200 text-slate-300">Готово</button>
          </div>
          <p className="text-xs text-slate-500">Ключ показан один раз — в базе хранится только его отпечаток.</p>
        </Card>
      )}

      {issued && (
        <Card className="border border-success/40 space-y-3">
          <div className="text-white font-semibold">Доступ выдан — отправьте клиенту</div>
          <pre className="bg-surface-200 rounded-lg p-3 text-sm text-slate-200 whitespace-pre-wrap">{message}</pre>
          <div className="flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(message); toast.success('Скопировано'); }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white"><Copy size={16} /> Скопировать</button>
            <button onClick={() => setIssued(null)} className="px-4 py-2 rounded-lg bg-surface-200 text-slate-300">Готово</button>
          </div>
          <p className="text-xs text-slate-500">Пароль нигде не хранится в открытом виде — после закрытия посмотреть его будет нельзя, только выдать новый.</p>
        </Card>
      )}

      <Card className="space-y-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2"><UserPlus size={18} /> Новый клиент</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {BUSINESS_TYPES.map(t => (
            <button key={t.key} type="button" onClick={() => setType(t.key)}
              className={`px-3 py-3 rounded-xl border text-left transition-all ${type === t.key ? 'border-primary bg-primary/15' : 'border-surface-300 bg-surface-200 hover:border-primary/40'}`}>
              <div className="text-white text-sm font-medium">{t.label}</div>
              <div className="text-xs text-slate-400 mt-0.5">{t.hint}</div>
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <input className={field} placeholder="Название объекта" value={form.object} onChange={e => u('object', e.target.value)} />
          <input className={field} placeholder="Город" value={form.city} onChange={e => u('city', e.target.value)} />
          <input className={field} placeholder="Адрес" value={form.address} onChange={e => u('address', e.target.value)} />
          <input className={field} placeholder="ФИО руководителя" value={form.fullName} onChange={e => u('fullName', e.target.value)} />
          <input className={field} placeholder="Логин (латиница)" value={form.login} onChange={e => u('login', e.target.value.toLowerCase())} />
          <div className="flex gap-2">
            <input className={field} placeholder="Пароль" value={form.password} onChange={e => u('password', e.target.value)} />
            <button type="button" onClick={() => u('password', genPassword())} title="Сгенерировать"
              className="px-3 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300"><RefreshCw size={16} /></button>
          </div>
        </div>
        <button disabled={busy || form.object.trim().length < 2 || form.login.length < 3 || form.password.length < 8} onClick={create}
          className="px-5 py-2.5 rounded-lg bg-primary text-white disabled:opacity-40">
          {busy ? 'Создаю…' : 'Создать объект и доступ'}
        </button>
        <p className="text-xs text-slate-500">
          Клиент получит роль администратора своего объекта: увидит камеры, инциденты, посетителей и всё, что положено его типу.
          Настройки Ауры, бриджи и профиль объекта остаются только у вас.
        </p>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="px-6 pt-5 pb-3 text-lg font-semibold text-white">Клиенты: {clients.length}</div>
        <div className="divide-y divide-surface-300">
          {clients.map(c => (
            <div key={c.mall_id}>
            <div className="flex flex-wrap items-center gap-3 px-6 py-3 text-sm">
              <span className="px-2 py-0.5 rounded bg-primary/15 text-primary-light text-xs">{typeLabel(c.business_type)}</span>
              <span className="text-white">{c.name}</span>
              {c.city && <span className="text-slate-500">· {c.city}</span>}
              <span className="text-slate-400 ml-auto">{c.login ? `${c.login}${c.full_name ? ` · ${c.full_name}` : ''}` : 'нет администратора'}</span>
              <input
                defaultValue={c.site_subnets.join(', ')}
                placeholder="Сеть объекта: 192.168.1"
                title="Где бридж ищет камеры этого объекта. Узнать: /ip address print на коробке, адрес у ether1"
                onBlur={e => { if (e.target.value !== c.site_subnets.join(', ')) saveNets(c, e.target.value); }}
                className="w-48 bg-surface-200 border border-[rgba(150,215,255,0.2)] rounded-lg px-2 py-1 text-xs text-white"
              />
              <button onClick={() => setOpenId(openId === c.mall_id ? null : c.mall_id)}
                className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs ${openId === c.mall_id ? 'bg-primary text-white' : 'bg-surface-200 text-slate-300 hover:bg-surface-300'}`}>
                <SlidersHorizontal size={13} /> Функции
              </button>
              <button onClick={() => newPosKey(c)} className="px-3 py-1 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300 text-xs">Касса</button>
              {c.user_id && (
                <button onClick={() => reset(c)} className="flex items-center gap-1 px-3 py-1 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300">
                  <KeyRound size={14} /> Новый пароль
                </button>
              )}
            </div>
            {openId === c.mall_id && <ClientFeatures mallId={c.mall_id} onChanged={load} />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
