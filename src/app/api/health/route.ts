

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const deep = url.searchParams.get('deep') === '1';
  const t0 = Date.now();

  if (!deep) {
    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime?.() ?? null,
    });
  }

  const checks: Record<string, { ok: boolean; latency_ms?: number; error?: string; mode?: string }> = {};

  const sbStart = Date.now();
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !key) throw new Error('Supabase env not set');
    const sb = createClient(supabaseUrl, key, { auth: { persistSession: false } });
    // Под anon-ключом RLS вернёт 0 строк — это НОРМА, а не поломка.
    // Проверяем именно доступность базы: важна ошибка соединения, а не число строк.
    const { error } = await sb.from('malls').select('id').limit(1);
    if (error) throw error;
    checks.supabase = {
      ok: true,
      latency_ms: Date.now() - sbStart,
      mode: process.env.SUPABASE_SERVICE_KEY ? 'service' : 'anon (RLS активен, строки скрыты — это ожидаемо)',
    };
  } catch (e: any) {
    checks.supabase = { ok: false, error: e.message };
  }

  checks.openai = process.env.OPENAI_API_KEY
    ? { ok: true }
    : { ok: false, error: 'OPENAI_API_KEY not set' };

  checks.telegram = process.env.TELEGRAM_BOT_TOKEN
    ? { ok: true }
    : { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const allOk = Object.values(checks).every(c => c.ok);

  return NextResponse.json(
    {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      total_latency_ms: Date.now() - t0,
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
