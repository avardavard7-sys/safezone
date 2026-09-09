'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f172a',
          color: 'white',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px',
        }}>
          <div style={{ maxWidth: 480, textAlign: 'center' }}>
            <div style={{
              width: 80, height: 80, borderRadius: '50%',
              background: 'rgba(239, 68, 68, 0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 24px',
            }}>
              <AlertTriangle size={40} color="#ef4444" />
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>
              Что-то пошло не так
            </h1>
            <p style={{ color: '#94a3b8', marginBottom: 24, lineHeight: 1.6 }}>
              Произошла непредвиденная ошибка. Мы уже знаем о ней и работаем над исправлением.
            </p>
            {error.digest && (
              <p style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace', marginBottom: 24 }}>
                ID ошибки: {error.digest}
              </p>
            )}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button onClick={reset} style={{
                padding: '12px 24px', borderRadius: 12, border: 'none',
                background: '#6366f1', color: 'white', fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <RefreshCw size={16} />Попробовать снова
              </button>
              <a href="/dashboard" style={{
                padding: '12px 24px', borderRadius: 12,
                background: '#1e293b', color: 'white', fontWeight: 600, textDecoration: 'none',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <Home size={16} />На дашборд
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
