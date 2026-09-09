'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Camera as CamIcon, Wifi, WifiOff } from 'lucide-react';
import { formatTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

export default function LiveCamera({ cameraId, cameraName, className, showInfo = true, onClick }: { cameraId: string; cameraName: string; className?: string; showInfo?: boolean; onClick?: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('offline');
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sb = createClient();

    const load = async () => {
      const { data } = await sb.from('cameras').select('last_frame_base64, status, updated_at').eq('id', cameraId).single();
      if (data) {
        if (data.last_frame_base64) setFrame(data.last_frame_base64);
        if (data.status) setStatus(data.status);
        if (data.updated_at) setLastUpdate(data.updated_at);
      }
      setLoading(false);
    };
    load();

    const channel = sb.channel(`camera-${cameraId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cameras', filter: `id=eq.${cameraId}` }, (payload: any) => {
        if (payload.new.last_frame_base64) setFrame(payload.new.last_frame_base64);
        if (payload.new.status) setStatus(payload.new.status);
        if (payload.new.updated_at) setLastUpdate(payload.new.updated_at);
      })
      .subscribe();

    const interval = setInterval(load, 5000);

    return () => {
      sb.removeChannel(channel);
      clearInterval(interval);
    };
  }, [cameraId]);

  return (
    <div onClick={onClick} className={cn('relative glass-card overflow-hidden group', onClick && 'cursor-pointer hover:border-primary/40 transition-all', className)}>
      {}
      <div className="relative aspect-video bg-surface-300 overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : frame ? (
          <>
            <img src={`data:image/jpeg;base64,${frame}`} alt={cameraName} className="w-full h-full object-cover" />
            <div className="scan-line absolute inset-0 pointer-events-none" />
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <CamIcon className="w-12 h-12 text-slate-600 mb-2" />
            <p className="text-xs text-slate-500">Нет сигнала</p>
            <p className="text-xs text-slate-600 mt-1">Ожидание Bridge...</p>
          </div>
        )}

        {}
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm">
          {status === 'online' ? (
            <><div className="w-2 h-2 rounded-full bg-green-400 pulse-green" /><span className="text-xs text-green-400 font-medium">LIVE</span></>
          ) : (
            <><div className="w-2 h-2 rounded-full bg-red-400" /><span className="text-xs text-red-400 font-medium">OFFLINE</span></>
          )}
        </div>

        {}
        {lastUpdate && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/60 backdrop-blur-sm">
            <p className="text-xs text-white font-mono">{formatTime(lastUpdate)}</p>
          </div>
        )}

        {}
        {showInfo && (
          <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
            <p className="text-sm font-medium text-white truncate">{cameraName}</p>
          </div>
        )}
      </div>
    </div>
  );
}
