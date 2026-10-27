import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Приём чеков из любой кассовой системы: POST /api/pos, заголовок X-Pos-Key,
// тело {"events":[{"kind":"sale|return|void|drawer_open","receipt_id":"…","amount":1500,"at":"ISO"}]}
export async function POST(req: Request) {
  const key = req.headers.get('x-pos-key') || '';
  if (!/^pos_[a-f0-9]{48}$/.test(key)) return NextResponse.json({ ok: false, error: 'нужен ключ кассы в заголовке X-Pos-Key' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'тело запроса — JSON' }, { status: 400 }); }
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events || !events.length || events.length > 500) return NextResponse.json({ ok: false, error: 'нужен массив events, от 1 до 500' }, { status: 400 });
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc('pos_ingest', { p_key: key, p_events: events });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: /ключ/.test(error.message) ? 401 : 400 });
  return NextResponse.json({ ok: true, ...(data as object) });
}
