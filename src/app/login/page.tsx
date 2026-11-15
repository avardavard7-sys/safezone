'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Eye, EyeOff } from 'lucide-react';
import { motion } from 'framer-motion';
import { AuraMark } from '@/components/aura/AuraMark';
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
      try { sessionStorage.removeItem('safezone:greeted'); } catch {}
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
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      >
        <AuraMark variant="full" height={170} className="max-w-[60vw] h-auto" />
      </motion.div>

      <motion.div
        className="w-full max-w-md"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.25, ease: 'easeOut' }}
      >
        <form onSubmit={handleLogin} className="aura-glass rounded-2xl p-8 space-y-5">
          <div className="text-center space-y-1">
            <div className="text-xs font-semibold tracking-[0.3em] text-ice/90">AURA</div>
            <h1 className="text-3xl font-display font-bold text-gradient">SafeZone</h1>
            <p className="text-sm text-slate-400">Интеллектуальная безопасность вашего объекта</p>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1.5">Логин</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username"
              className="w-full px-4 py-3 rounded-xl border border-[rgba(150,215,255,0.2)] text-white focus:border-ice/60 focus:outline-none transition-colors"
              placeholder="Логин" required />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1.5">Пароль</label>
            <div className="relative">
              <input type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"
                className="w-full px-4 py-3 rounded-xl border border-[rgba(150,215,255,0.2)] text-white focus:border-ice/60 focus:outline-none transition-colors pr-12"
                placeholder="Пароль" required />
              <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
                className="absolute right-3 top-3 text-slate-400 hover:text-ice">{show ? <EyeOff size={20} /> : <Eye size={20} />}</button>
            </div>
          </div>
          <Button type="submit" loading={loading} className="w-full justify-center">Войти</Button>
          <p className="text-center text-sm text-slate-400">Забыли пароль? Новый выдаст администратор Aura SafeZone.</p>
        </form>
      </motion.div>

      <p className="text-center text-xs text-slate-500">Mila Chess IT · Aura SafeZone</p>
    </div>
  );
}
