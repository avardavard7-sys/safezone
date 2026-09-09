'use client';
import { cn } from '@/lib/utils';

export function Card({ children, className, glow, onClick }: { children: React.ReactNode; className?: string; glow?: boolean; onClick?: () => void }) {
  return <div onClick={onClick} className={cn('glass-card p-6', glow && 'glow-indigo', onClick && 'cursor-pointer hover:border-primary/30 transition-all', className)}>{children}</div>;
}

export function StatCard({ title, value, subtitle, icon, color = 'primary', trend }: { title: string; value: string | number; subtitle?: string; icon?: React.ReactNode; color?: string; trend?: string }) {
  const c: Record<string, string> = {
    primary: 'text-primary',
    accent: 'text-accent',
    danger: 'text-danger',
    success: 'text-success'
  };
  return (
    <div className="glass-card p-5 hover:border-primary/30 transition-all">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-slate-400">{title}</span>
        {icon && <span className={cn('opacity-70', c[color])}>{icon}</span>}
      </div>
      <div className={cn('text-3xl font-bold font-display', c[color])}>{value}</div>
      {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
      {trend && <p className="text-xs text-success mt-1">{trend}</p>}
    </div>
  );
}
