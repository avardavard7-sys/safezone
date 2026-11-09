import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export async function POST(req: Request) {
  const limited = await rateLimit(req, 'telegram-test', { limit: 10, window: 60 });
  if (limited) return limited;

  const header = req.headers.get('authorization') || '';
  const accessToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!accessToken) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: noStore });
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await sb.auth.getUser(accessToken);
  if (authError || !auth?.user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: noStore });

  try {
    const { bot_token, chat_id, message, image_url } = await req.json();
    if (!bot_token || !chat_id) return NextResponse.json({ ok: false, error: 'No token or chat_id' }, { headers: noStore });
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(String(bot_token))) {
      return NextResponse.json({ ok: false, error: 'Неверный формат токена бота' }, { status: 400, headers: noStore });
    }
    const text = String(message || '').slice(0, 1000);
    const photo = typeof image_url === 'string' && /^https:\/\//.test(image_url) ? image_url : null;
    const url = `https://api.telegram.org/bot${bot_token}/${photo ? 'sendPhoto' : 'sendMessage'}`;
    const body = photo ? { chat_id, photo, caption: text, parse_mode: 'HTML' } : { chat_id, text, parse_mode: 'HTML' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    return NextResponse.json({ ok: !!data.ok, error: data.ok ? undefined : data.description }, { headers: noStore });
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось отправить сообщение' }, { status: 502, headers: noStore });
  }
}
