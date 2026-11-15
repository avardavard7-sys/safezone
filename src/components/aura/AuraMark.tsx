'use client';

import { cn } from '@/lib/utils';

/**
 * Знак Mila Chess IT.
 * - `mark`: «M» с синей точкой — для шапки и меню
 * - `full`: круглый знак «MILA CHESS · IT COMPANY» — для экрана входа
 */
const SOURCES = {
  mark: { src: '/brand/mila-mark-white.png', ratio: 1.17 },
  full: { src: '/brand/mila-full.png', ratio: 1 },
} as const;

export function AuraMark({ className, variant = 'mark', height = 28 }: { className?: string; variant?: keyof typeof SOURCES; height?: number }) {
  const { src, ratio } = SOURCES[variant];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Mila Chess IT"
      width={Math.round(height * ratio)}
      height={height}
      className={cn('object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.75)]', className)}
      draggable={false}
    />
  );
}
