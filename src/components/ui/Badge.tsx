'use client';
import { cn } from '@/lib/utils';

const sev: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  high: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  critical: 'bg-red-500/20 text-red-400 border border-red-500/30 blink-critical',
};

const stat: Record<string, string> = {
  new: 'bg-red-500/20 text-red-400',
  reviewing: 'bg-yellow-500/20 text-yellow-400',
  resolved: 'bg-green-500/20 text-green-400',
  false_alarm: 'bg-slate-500/20 text-slate-400',
  online: 'bg-green-500/20 text-green-400',
  offline: 'bg-red-500/20 text-red-400',
  error: 'bg-orange-500/20 text-orange-400',
  pending: 'bg-yellow-500/20 text-yellow-400',
  confirmed: 'bg-blue-500/20 text-blue-400',
  paid: 'bg-green-500/20 text-green-400',
  disputed: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-slate-500/20 text-slate-400',
};

const types: Record<string, string> = {
  theft: '🔓 Кража',
  fight: '👊 Драка',
  crowd: '👥 Скопление',
  fire: '🔥 Пожар',
  smoking: '🚬 Курение',
  child_lost: '👶 Потерянный ребёнок',
  escalator: '⚠️ Эскалатор',
  violation: '📋 Нарушение',
  suspicious: '🔍 Подозрительное',
  fall: '🤕 Падение',
  access: '🚪 Доступ',
  vandalism: '💥 Вандализм',
};

const statLabels: Record<string, string> = {
  new: 'Новое',
  reviewing: 'На проверке',
  resolved: 'Решено',
  false_alarm: 'Ложное',
  online: 'Онлайн',
  offline: 'Оффлайн',
  error: 'Ошибка',
  pending: 'Ожидает',
  confirmed: 'Подтверждён',
  paid: 'Оплачен',
  disputed: 'Оспорен',
  cancelled: 'Отменён',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', sev[severity])}>{severity?.toUpperCase()}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', stat[status])}>{statLabels[status] || status}</span>;
}

export function TypeBadge({ type }: { type: string }) {
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-200 text-slate-300">{types[type] || type}</span>;
}
