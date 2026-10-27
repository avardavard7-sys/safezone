

import { NextResponse } from 'next/server';

type RateLimitResult = { success: boolean; limit: number; remaining: number; reset: number };

const memoryStore = new Map<string, { count: number; resetAt: number }>();

async function checkUpstash(key: string, limit: number, windowSec: number): Promise<RateLimitResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {

    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, windowSec, 'NX'],
        ['TTL', key],
      ]),
    });
    const data = await res.json();
    const count = parseInt(data[0]?.result || '0');
    const ttl = parseInt(data[2]?.result || windowSec);
    return {
      success: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      reset: Date.now() + ttl * 1000,
    };
  } catch {
    return null;
  }
}

function checkMemory(key: string, limit: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || entry.resetAt < now) {
    memoryStore.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { success: true, limit, remaining: limit - 1, reset: now + windowSec * 1000 };
  }

  entry.count++;
  return {
    success: entry.count <= limit,
    limit,
    remaining: Math.max(0, limit - entry.count),
    reset: entry.resetAt,
  };
}

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of memoryStore.entries()) if (v.resetAt < now) memoryStore.delete(k);
  }, 60000);
}

export async function rateLimit(
  req: Request,
  bucket: string,
  opts: { limit: number; window: number } = { limit: 60, window: 60 }
): Promise<Response | null> {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'anonymous';
  const key = `rl:${bucket}:${ip}`;

  const result =
    (await checkUpstash(key, opts.limit, opts.window)) ?? checkMemory(key, opts.limit, opts.window);

  const headers = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.floor(result.reset / 1000)),
  };

  if (!result.success) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: Math.ceil((result.reset - Date.now()) / 1000) },
      { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((result.reset - Date.now()) / 1000)) } }
    );
  }
  return null;
}
