'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);

  return (
    <div className="min-h-[400px] flex items-center justify-center p-6">
      <Card className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle size={32} className="text-danger" />
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">Ошибка загрузки</h2>
        <p className="text-slate-400 text-sm mb-4">
          Не удалось загрузить эту страницу. Ошибка зафиксирована.
        </p>
        {error.digest && (
          <p className="text-xs text-slate-600 font-mono mb-4">ID: {error.digest}</p>
        )}
        <Button onClick={reset}><RefreshCw size={16} />Перезагрузить</Button>
      </Card>
    </div>
  );
}
