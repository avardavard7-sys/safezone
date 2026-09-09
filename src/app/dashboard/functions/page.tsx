'use client';

import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { createClient } from '@/lib/supabase/client';
import { BridgeSettings } from '@/components/settings/BridgeSettings';

export default function FunctionsPage() {
  const [mallId, setMallId] = useState<string | null>(null);
  const sb = createClient();

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: profile } = await sb.from('profiles').select('mall_id').eq('id', user.id).maybeSingle();
      if (profile?.mall_id) setMallId(profile.mall_id);
    })();
  }, []);

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-white">Функции анализа</h1>
        <p className="text-slate-400 text-sm">
          Что именно бридж делает с видео. Меняется на лету — без перезапуска.
        </p>
      </div>
      {mallId
        ? <BridgeSettings mallId={mallId} supabase={sb} />
        : <p className="text-slate-500 text-sm">Загрузка профиля…</p>}
    </DashboardLayout>
  );
}
