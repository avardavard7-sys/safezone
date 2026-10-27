'use client';

import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

export type TrackBox = { id: number; b: [number, number, number, number] };
export type TrackMsg = { camera_id: string; t: number; tracks: TrackBox[]; receivedAt: number };

let channel: RealtimeChannel | null = null;
let channelMall = '';
let subscribed = false;
let viewerKey = '';
const watching = new Map<string, number>();
const listeners = new Set<(m: TrackMsg) => void>();

function pushPresence() {
  if (!channel || !subscribed) return;
  // одна камера на зрителя: полноэкранный просмотр всегда один
  const cam = [...watching.keys()].pop();
  if (cam) channel.track({ camera_id: cam });
  else channel.untrack();
}

function ensure(mallId: string) {
  if (channel && channelMall === mallId) return;
  if (channel) createClient().removeChannel(channel);
  if (!viewerKey) viewerKey = `viewer-${Math.random().toString(36).slice(2)}`;
  subscribed = false;
  channelMall = mallId;
  channel = createClient().channel(`overlay:${mallId}`, { config: { presence: { key: viewerKey } } });
  channel.on('broadcast', { event: 'tracks' }, ({ payload }) => {
    const m = { ...(payload as Omit<TrackMsg, 'receivedAt'>), receivedAt: Date.now() };
    listeners.forEach(l => l(m));
  });
  channel.subscribe(status => {
    subscribed = status === 'SUBSCRIBED';
    if (subscribed) pushPresence();
  });
}

/** Рамки людей для камеры. Пока хук активен, бридж знает, что камеру смотрят. */
export function useOverlayTracks(mallId: string | undefined, cameraId: string, active: boolean) {
  const [msg, setMsg] = useState<TrackMsg | null>(null);

  useEffect(() => {
    if (!mallId || !active) return;
    ensure(mallId);
    watching.set(cameraId, (watching.get(cameraId) || 0) + 1);
    pushPresence();
    const onMsg = (m: TrackMsg) => { if (m.camera_id === cameraId) setMsg(m); };
    listeners.add(onMsg);
    return () => {
      listeners.delete(onMsg);
      const n = (watching.get(cameraId) || 1) - 1;
      if (n <= 0) watching.delete(cameraId); else watching.set(cameraId, n);
      pushPresence();
      setMsg(null);
    };
  }, [mallId, cameraId, active]);

  return msg;
}
