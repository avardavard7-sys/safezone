'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Camera as CamIcon } from 'lucide-react';
import { formatTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import LivePlayer, { type LiveState } from './LivePlayer';

const BADGE: Record<LiveState, { text: string; dot: string; label: string }> = {
  live: { text: 'LIVE', dot: 'bg-green-400 pulse-green', label: 'text-green-400' },
  authorizing: { text: 'ПОДКЛЮЧЕНИЕ', dot: 'bg-amber-400 animate-pulse', label: 'text-amber-300' },
  connecting: { text: 'ПОДКЛЮЧЕНИЕ', dot: 'bg-amber-400 animate-pulse', label: 'text-amber-300' },
  reconnecting: { text: 'ПЕРЕПОДКЛЮЧЕНИЕ', dot: 'bg-amber-400 animate-pulse', label: 'text-amber-300' },
  offline: { text: 'НЕТ СИГНАЛА', dot: 'bg-red-400', label: 'text-red-400' },
  denied: { text: 'НЕТ ДОСТУПА', dot: 'bg-red-400', label: 'text-red-400' },
  unavailable: { text: 'СНИМОК', dot: 'bg-slate-400', label: 'text-slate-300' },
  idle: { text: 'ПАУЗА', dot: 'bg-slate-500', label: 'text-slate-400' },
};

export default function LiveCamera({ cameraId, cameraName, className, showInfo = true, onClick }: { cameraId: string; cameraName: string; className?: string; showInfo?: boolean; onClick?: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [frameAt, setFrameAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<LiveState>('idle');
  const snapshotMode = live === 'unavailable';
  const [entries, setEntries] = useState<number | null>(null);

  // компактная метка подсчёта в плитке; полные цифры — в полном просмотре
  useEffect(() => {
    const sb = createClient();
    const load = () => sb.rpc('line_day_counts', { cam: cameraId }).then(({ data }) => {
      const ls = (data as { entries: number }[]) || [];
      setEntries(ls.length ? ls.reduce((n, l) => n + l.entries, 0) : null);
    });
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [cameraId]);

  // снимок нужен всегда как подложка, пока поднимается видео;
  // обновлять его постоянно — только если LIVE на объекте не настроен
  useEffect(() => {
    const sb = createClient();
    let stop = false;

    const load = async () => {
      const { data } = await sb.from('cameras').select('last_frame_base64, last_frame_at, updated_at').eq('id', cameraId).single();
      if (stop) return;
      if (data?.last_frame_base64) {
        setFrame(data.last_frame_base64);
        setFrameAt(data.last_frame_at || data.updated_at);
      }
      setLoading(false);
    };
    load();

    if (!snapshotMode) return () => { stop = true; };

    const channel = sb.channel(`camera-${cameraId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cameras', filter: `id=eq.${cameraId}` }, (payload: any) => {
        if (payload.new.last_frame_base64) {
          setFrame(payload.new.last_frame_base64);
          setFrameAt(payload.new.last_frame_at || payload.new.updated_at);
        }
      })
      .subscribe();
    const interval = setInterval(load, 5000);

    return () => {
      stop = true;
      sb.removeChannel(channel);
      clearInterval(interval);
    };
  }, [cameraId, snapshotMode]);

  const badge = BADGE[live];
  const showVideo = !snapshotMode;

  return (
    <div onClick={onClick} className={cn('relative glass-card overflow-hidden group', onClick && 'cursor-pointer hover:border-primary/40 transition-all', className)}>
      <div className="relative aspect-video bg-surface-300 overflow-hidden">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt={cameraName}
            className={cn('absolute inset-0 w-full h-full object-cover transition-opacity duration-300', live === 'live' ? 'opacity-0' : 'opacity-100', !snapshotMode && live !== 'live' && 'blur-[1px] brightness-75')}
          />
        ) : loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : live !== 'live' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <CamIcon className="w-12 h-12 text-slate-600 mb-2" />
            <p className="text-xs text-slate-500">Нет сигнала</p>
          </div>
        ) : null}

        {showVideo && <LivePlayer cameraId={cameraId} className="absolute inset-0" onState={setLive} />}

        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm">
          <div className={cn('w-2 h-2 rounded-full', badge.dot)} />
          <span className={cn('text-xs font-medium', badge.label)}>{badge.text}</span>
        </div>

        {/* время показываем только у снимка: у живого видео оно бессмысленно */}
        {live !== 'live' && frameAt && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/60 backdrop-blur-sm">
            <p className="text-xs text-white font-mono">{formatTime(frameAt)}</p>
          </div>
        )}

        {entries !== null && (
          <div className="absolute bottom-2 right-2 px-2 py-1 rounded bg-black/60 backdrop-blur-sm text-xs text-green-400 font-medium">
            вошло {entries}
          </div>
        )}

        {showInfo && (
          <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
            <p className="text-sm font-medium text-white truncate">{cameraName}</p>
          </div>
        )}
      </div>
    </div>
  );
}
