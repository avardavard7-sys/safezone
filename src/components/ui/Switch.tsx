'use client';

import { cn } from '@/lib/utils';

/** Переключатель в стиле Ауры: ледяной, когда включён. Ползунок всегда внутри дорожки. */
export function Switch({ checked, onChange, disabled, label, className }: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-[#96d7ff]/60 bg-[#96d7ff]/35' : 'border-[rgba(150,215,255,0.2)] bg-[rgba(4,7,26,0.6)]',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute left-[3px] top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full transition-transform duration-200',
          checked ? 'translate-x-[19px] bg-[#96d7ff] shadow-[0_0_10px_rgba(150,215,255,0.6)]' : 'translate-x-0 bg-[#c6d2f0]',
        )}
      />
    </button>
  );
}
