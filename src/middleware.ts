import { NextResponse, type NextRequest } from 'next/server';

function originOf(url?: string) {
  try { return url ? new URL(url).origin : ''; } catch { return ''; }
}

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  // сервер видео LIVE: без него в connect-src браузер молча режет запрос плеера
  const media = originOf(process.env.MEDIA_PUBLIC_URL);

  res.headers.set('X-Frame-Options', 'SAMEORIGIN');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-DNS-Prefetch-Control', 'on');
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://*.sentry-cdn.com https://*.ingest.sentry.io",
    // фоновый поток распознавания лиц на странице «Тест AI»
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: data:",
    // Локальный бридж на машине оператора: кнопки «Найти камеры», «Проверить»
    // и вкладка «Функции» ходят на него. Без этих источников браузер молча
    // режет запрос по CSP, и кнопки выглядят сломанными без ошибки в UI.
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.openai.com https://*.ingest.sentry.io https://api.telegram.org http://127.0.0.1:8099 http://localhost:8099${media ? ' ' + media : ''}`,
    "font-src 'self' data:",
    "frame-ancestors 'self'",
  ].join('; ');
  res.headers.set('Content-Security-Policy', csp);

  return res;
}

export const config = {
  matcher: [

    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
