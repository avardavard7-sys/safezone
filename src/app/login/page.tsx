'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { Shield, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const sb = createClient();
      // Профиль читаем ПОСЛЕ входа: до авторизации мы аноним, а RLS ему таблицы
      // не отдаёт. Заодно исчезает перебор логинов — раньше по ответу можно было
      // узнать, какие пользователи существуют.
      const email = `${username.trim().toLowerCase()}@safezone.kz`;
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { toast.error('Неверный логин или пароль'); setLoading(false); return; }

      const { data: profile } = await sb.from('profiles').select('*').eq('id', (await sb.auth.getUser()).data.user?.id ?? '').maybeSingle();
      if (!profile) {
        await sb.auth.signOut();
        toast.error('Профиль не найден — обратитесь к администратору');
        setLoading(false);
        return;
      }
      if (!profile.is_approved) {
        await sb.auth.signOut();
        toast.error('Заявка на рассмотрении');
        setLoading(false);
        return;
      }
      toast.success('Добро пожаловать в SafeZone!');
      router.push('/dashboard');
    } catch (err) { toast.error('Ошибка входа'); }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/20 flex items-center justify-center mx-auto mb-4 glow-indigo">
            <Shield className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-display font-bold text-gradient mb-2">SafeZone</h1>
          <p className="text-slate-400">Безопасная среда — AI-защита для ТРЦ</p>
        </div>
        <form onSubmit={handleLogin} className="glass-card p-8 space-y-5">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Логин</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none" placeholder="Введите логин" required />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Пароль</label>
            <div className="relative">
              <input type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white focus:border-primary focus:outline-none pr-12" placeholder="Введите пароль" required />
              <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-3 text-slate-500">{show ? <EyeOff size={20} /> : <Eye size={20} />}</button>
            </div>
          </div>
          <Button type="submit" loading={loading} className="w-full justify-center">Войти</Button>
          <p className="text-center text-sm text-slate-500">Нет аккаунта? <Link href="/register" className="text-primary hover:text-primary-light">Регистрация</Link></p>
        </form>
      </div>
    </div>
  );
}
