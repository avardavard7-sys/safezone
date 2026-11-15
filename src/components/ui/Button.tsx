'use client';
import { cn } from '@/lib/utils';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'danger' | 'ghost' | 'accent' | 'success';
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ children, variant = 'primary', size = 'md', className, loading, ...props }: Props) {
  const v: Record<string, string> = {
    primary: 'bg-primary hover:bg-primary-dark text-white',
    danger: 'bg-danger hover:bg-red-600 text-white',
    ghost: 'bg-transparent hover:bg-surface-200 text-slate-300 border border-surface-300',
    accent: 'bg-accent hover:bg-accent-dark text-black font-semibold',
    success: 'bg-success hover:bg-green-600 text-white',
  };
  const s: Record<string, string> = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-6 py-3 text-base',
  };
  return (
    <button className={cn('rounded-xl font-medium transition-all disabled:opacity-50 flex items-center gap-2', v[variant], s[size], className)} disabled={loading || props.disabled} {...props}>
      {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
      {children}
    </button>
  );
}
