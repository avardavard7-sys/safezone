'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { Shield, Building2, User, CheckCircle } from 'lucide-react';
import toast from 'react-hot-toast';

export default function RegisterPage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ mallName: '', mallAddress: '', mallCity: 'Туркестан', username: '', password: '', fullName: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const u = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const sb = createClient();

      // До регистрации мы аноним — прямой select из profiles закрыт политикой RLS.
      // RPC отдаёт только да/нет, ни строк, ни колонок наружу не уходит.
      const { data: free, error: checkErr } = await sb.rpc('username_available', { u: form.username });
      if (checkErr) {
        toast.error('Не удалось проверить логин: ' + checkErr.message);
        setLoading(false);
        return;
      }
      if (!free) {
        toast.error('Логин уже занят');
        setLoading(false);
        return;
      }

      const email = `${form.username.trim().toLowerCase()}@safezone.kz`;

      const { data: authData, error: authErr } = await sb.auth.signUp({ email, password: form.password });
      if (authErr) {
        toast.error(authErr.message);
        setLoading(false);
        return;
      }
      if (!authData.user) {
        toast.error('Не удалось создать пользователя');
        setLoading(false);
        return;
      }

      const { data: mall, error: mallErr } = await sb.from('malls').insert({
        name: form.mallName,
        address: form.mallAddress,
        city: form.mallCity,
        is_approved: false,
      }).select().single();

      if (mallErr || !mall) {
        toast.error('Ошибка создания ТРЦ: ' + (mallErr?.message || ''));
        setLoading(false);
        return;
      }

      const { error: profileErr } = await sb.from('profiles').insert({
        id: authData.user.id,
        username: form.username,
        full_name: form.fullName,
        phone: form.phone,
        mall_id: mall.id,
        role: 'admin',
        is_approved: false,
      });

      if (profileErr) {
        toast.error('Ошибка создания профиля: ' + profileErr.message);
        setLoading(false);
        return;
      }

      setDone(true);
    } catch (err: any) {
      toast.error('Ошибка регистрации: ' + (err.message || ''));
    }
    setLoading(false);
  };

  if (done) return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-4">
      <div className="glass-card p-8 text-center max-w-md">
        <CheckCircle className="w-16 h-16 text-success mx-auto mb-4" />
        <h2 className="text-2xl font-display font-bold text-white mb-2">Заявка отправлена!</h2>
        <p className="text-slate-400 mb-6">Ваша заявка на подключение ТРЦ принята. Мы свяжемся с вами после проверки.</p>
        <Link href="/login"><Button className="w-full justify-center">Вернуться на вход</Button></Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/20 flex items-center justify-center mx-auto mb-4 glow-indigo">
            <Shield className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-display font-bold text-gradient mb-2">Регистрация ТРЦ</h1>
          <p className="text-slate-400">Подключите ваш торговый центр к SafeZone</p>
        </div>
        <div className="flex gap-2 mb-6">{[1, 2].map(s => <div key={s} className={`flex-1 h-1.5 rounded-full ${step >= s ? 'bg-primary' : 'bg-surface-300'}`} />)}</div>
        <form onSubmit={step === 1 ? (e) => { e.preventDefault(); setStep(2); } : handleRegister} className="glass-card p-8 space-y-5">
          {step === 1 ? (
            <>
              <div className="flex items-center gap-2 text-primary mb-4"><Building2 size={20} /><span className="font-display font-semibold">Данные ТРЦ</span></div>
              <div><label className="block text-sm text-slate-400 mb-1">Название ТРЦ</label><input type="text" value={form.mallName} onChange={e => u('mallName', e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" placeholder="ТРЦ Turan Mall" required /></div>
              <div><label className="block text-sm text-slate-400 mb-1">Адрес</label><input type="text" value={form.mallAddress} onChange={e => u('mallAddress', e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" required /></div>
              <div><label className="block text-sm text-slate-400 mb-1">Город</label><input type="text" value={form.mallCity} onChange={e => u('mallCity', e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" required /></div>
              <Button type="submit" className="w-full justify-center">Далее</Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-primary mb-4"><User size={20} /><span className="font-display font-semibold">Данные администратора</span></div>
              <div><label className="block text-sm text-slate-400 mb-1">Логин (латиница, без пробелов)</label><input type="text" value={form.username} onChange={e => u('username', e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" placeholder="admin" required minLength={3} /></div>
              <div><label className="block text-sm text-slate-400 mb-1">ФИО</label><input type="text" value={form.fullName} onChange={e => u('fullName', e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" required /></div>
              <div><label className="block text-sm text-slate-400 mb-1">Телефон</label><input type="tel" value={form.phone} onChange={e => u('phone', e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" /></div>
              <div><label className="block text-sm text-slate-400 mb-1">Пароль (минимум 6 символов)</label><input type="password" value={form.password} onChange={e => u('password', e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" required minLength={6} /></div>
              <div className="flex gap-3"><Button type="button" variant="ghost" onClick={() => setStep(1)} className="flex-1 justify-center">Назад</Button><Button type="submit" loading={loading} className="flex-1 justify-center">Зарегистрировать</Button></div>
            </>
          )}
          <p className="text-center text-sm text-slate-500">Уже есть аккаунт? <Link href="/login" className="text-primary">Войти</Link></p>
        </form>
      </div>
    </div>
  );
}
