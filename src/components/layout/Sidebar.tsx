'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Camera, AlertTriangle, MapPin, Store, FileWarning, BarChart3, Settings, Shield, LogOut, Grid3x3, Code, Webcam, SlidersHorizontal, Server, ClipboardCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';

const nav = [
  { href: '/dashboard', label: 'Дашборд', icon: LayoutDashboard },
  { href: '/dashboard/monitoring', label: 'Мониторинг', icon: Grid3x3, hot: true },
  { href: '/dashboard/cameras', label: 'Камеры', icon: Camera },
  { href: '/dashboard/events', label: 'Инциденты', icon: AlertTriangle },
  { href: '/dashboard/zones', label: 'Зоны', icon: MapPin },
  { href: '/dashboard/tenants', label: 'Арендаторы', icon: Store },
  { href: '/dashboard/violations', label: 'Нарушения', icon: FileWarning },
  { href: '/dashboard/analytics', label: 'Аналитика', icon: BarChart3 },
  { href: '/dashboard/ai-demo', label: 'Тест AI', icon: Webcam },
  { href: '/dashboard/bridge', label: 'Бридж', icon: Server },
  { href: '/dashboard/zone-editor', label: 'Редактор зон', icon: Grid3x3 },
  { href: '/dashboard/compliance', label: 'Регламент', icon: ClipboardCheck },
  { href: '/dashboard/functions', label: 'Функции', icon: SlidersHorizontal },
  { href: '/dashboard/settings', label: 'Настройки', icon: Settings },
];

export default function Sidebar() {
  const p = usePathname();
  const router = useRouter();
  const { profile, logout } = useAuth();

  const handleLogout = async () => {
    const sb = createClient();
    await sb.auth.signOut();
    logout();
    router.push('/login');
  };

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-surface-100 border-r border-surface-300 z-40 flex flex-col">
      <div className="p-5 border-b border-surface-300">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center glow-indigo">
            <Shield className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="font-display font-bold text-lg text-white">SafeZone</h1>
            <p className="text-xs text-slate-500">Безопасная среда</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {nav.map((i) => {
          const a = p === i.href || (i.href !== '/dashboard' && p.startsWith(i.href));
          return (
            <Link key={i.href} href={i.href} className={cn('flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all relative', a ? 'bg-primary/15 text-primary' : 'text-slate-400 hover:text-slate-200 hover:bg-surface-200')}>
              <i.icon className="w-5 h-5" />
              <span className="flex-1">{i.label}</span>
              {i.hot && <span className="w-2 h-2 rounded-full bg-accent pulse-green" />}
            </Link>
          );
        })}

        {profile?.role === 'developer' && (
          <Link href="/dashboard/developer" className={cn('flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all mt-4', p.startsWith('/dashboard/developer') ? 'bg-accent/15 text-accent' : 'text-slate-400 hover:text-slate-200 hover:bg-surface-200')}>
            <Code className="w-5 h-5" />
            <span>Администратор</span>
          </Link>
        )}
      </nav>

      <div className="p-3 border-t border-surface-300">
        <div className="px-2 py-2 mb-2">
          <p className="text-xs text-slate-400">{profile?.full_name || profile?.username}</p>
          <p className="text-xs text-slate-600">{profile?.role || 'user'}</p>
        </div>
        <button onClick={handleLogout} className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-danger hover:bg-danger/10 transition-all">
          <LogOut className="w-5 h-5" />
          Выйти
        </button>
        <p className="text-xs text-slate-600 text-center mt-3">SafeZone v2.2</p>
      </div>
    </aside>
  );
}
