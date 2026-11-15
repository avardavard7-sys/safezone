import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

const MAX_IMAGE_CHARS = 3_000_000;
const MAX_PROMPT_CHARS = 12_000;
const noStore = { 'Cache-Control': 'no-store' };

type Attempt = { provider: string; result: any } | null;

function parseJson(text: string): any {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function viaOpenRouter(prompt: string, image: string): Promise<Attempt> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const model = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: 800, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
      ] }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = parseJson(data.choices?.[0]?.message?.content);
  return result ? { provider: 'openrouter', result } : null;
}

async function viaGemini(prompt: string, image: string): Promise<Attempt> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 800, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = parseJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
  return result ? { provider: 'gemini', result } : null;
}

async function viaOpenAI(prompt: string, image: string): Promise<Attempt> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' } },
      ] }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = parseJson(data.choices?.[0]?.message?.content);
  return result ? { provider: 'openai', result } : null;
}

export async function POST(req: Request) {
  const limited = await rateLimit(req, 'bridge-vision', { limit: 240, window: 60 });
  if (limited) return limited;

  const token = req.headers.get('x-bridge-token') || '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return NextResponse.json({ ok: false, reason: 'unknown' }, { status: 401, headers: noStore });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, reason: 'bad_request' }, { status: 400, headers: noStore }); }
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const image = typeof body?.image === 'string' ? body.image : '';
  if (!prompt || prompt.length > MAX_PROMPT_CHARS || !image || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return NextResponse.json({ ok: false, reason: 'bad_request' }, { status: 400, headers: noStore });
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: gate, error } = await sb.rpc('bridge_vision_gate', { bridge_token: token });
  if (error) return NextResponse.json({ ok: false, reason: 'unavailable' }, { status: 502, headers: noStore });
  if (!gate?.ok) {
    const status = gate?.reason === 'budget' ? 429 : gate?.reason === 'access' ? 403 : 401;
    return NextResponse.json({ ok: false, reason: gate?.reason || 'unknown' }, { status, headers: noStore });
  }

  for (const attempt of [viaOpenRouter, viaGemini, viaOpenAI]) {
    try {
      const got = await attempt(prompt, image);
      if (got) return NextResponse.json({ ok: true, provider: got.provider, result: got.result }, { headers: noStore });
    } catch {}
  }
  return NextResponse.json({ ok: false, reason: 'unavailable' }, { status: 503, headers: noStore });
}
