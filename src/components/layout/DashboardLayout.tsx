'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from './Sidebar';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Shield, Clock, MessageCircle } from 'lucide-react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { setUser, setProfile, setMall, profile: authProfile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [mallInfo, setMallInfo] = useState<any>(null);

  useEffect(() => {
    const sb = createClient();
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/login'); return; }
      setUser(user);
      const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
      if (profile) setProfile(profile);

      if (profile?.mall_id) {
        const { data: mall } = await sb.from('malls').select('*').eq('id', profile.mall_id).single();
        if (mall) {
          setMall(mall);
          setMallInfo(mall);

          if (profile.role === 'developer') {
            setLoading(false);
            return;
          }

          if (!mall.is_approved || !profile.is_approved) {
            setNeedsApproval(true);
          }
        }
      }
      setLoading(false);
    });
  }, []);

  const handleLogout = async () => {
    const sb = createClient();
    await sb.auth.signOut();
    router.push('/login');
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="text-center">
        <div className="relative w-16 h-16 mx-auto mb-4">
          <Shield className="w-16 h-16 text-primary animate-pulse" />
        </div>
        <p className="text-slate-400 font-display">SafeZone загружается...</p>
      </div>
    </div>
  );

  if (needsApproval) return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-4">
      <div className="glass-card p-10 text-center max-w-lg">
        <div className="w-20 h-20 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto mb-6">
          <Clock className="w-10 h-10 text-accent animate-pulse" />
        </div>
        <h1 className="text-2xl font-display font-bold text-white mb-3">Заявка на рассмотрении</h1>
        <p className="text-slate-400 mb-2">Спасибо за регистрацию!</p>
        <p className="text-slate-400 mb-6">ТРЦ <strong className="text-white">{mallInfo?.name}</strong> ожидает одобрения администратором системы SafeZone.</p>

        <div className="p-5 rounded-xl bg-primary/10 border border-primary/30 mb-6">
          <div className="flex items-center justify-center gap-2 mb-3">
            <MessageCircle className="w-5 h-5 text-primary" />
            <h3 className="font-display font-semibold text-primary">Для ускорения одобрения</h3>
          </div>
          <p className="text-sm text-slate-300 mb-3">Напишите нам в WhatsApp:</p>
          <a href="https://wa.me/77751405299" target="_blank" className="inline-block px-6 py-3 rounded-xl bg-success text-white font-medium hover:bg-green-600 transition-all">
            💬 +7 775 140 5299
          </a>
          <p className="text-xs text-slate-500 mt-3">Укажите название ТРЦ и логин для быстрого одобрения</p>
        </div>

        <button onClick={handleLogout} className="text-sm text-slate-500 hover:text-slate-300">
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-64 p-6">{children}</main>
    </div>
  );
}
