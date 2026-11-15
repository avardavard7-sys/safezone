'use client';

import { GlassFold } from './GlassFold';

export const AURA_FIELD = {
  color1: '#1e3cc8',
  color2: '#06081e',
  color3: '#96d7ff',
  speed: 0.5,
  scale: 1,
  noise: 0.12,
} as const;

/** Общий фон: закреплён за каждым экраном, не прокручивается, не перехватывает клики. */
export function AuraBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 bg-[#06081e]">
      <GlassFold {...AURA_FIELD} className="absolute inset-0" />
      <div className="absolute inset-0 bg-[rgba(6,8,30,0.32)]" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_40%,transparent_35%,rgba(6,8,30,0.7)_100%)]" />
    </div>
  );
}
