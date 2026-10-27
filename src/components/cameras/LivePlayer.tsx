'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export type LiveState =
  | 'idle'
  | 'authorizing'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'denied'
  | 'unavailable';

type Session = { whepUrl: string; token: string; expiresAt: number };

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
const STALL_MS = 6000;
const ICE_GATHER_MS = 1500;
const HIDDEN_GRACE_MS = 15000;

class HttpError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
}

async function requestSession(cameraId: string): Promise<Session> {
  const { data } = await createClient().auth.getSession();
  const access = data.session?.access_token;
  if (!access) throw new HttpError(401);
  const res = await fetch(`/api/cameras/${cameraId}/live`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

function gatheringDone(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, ICE_GATHER_MS);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function framesDecoded(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  let n = 0;
  stats.forEach(s => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') n = s.framesDecoded || 0;
  });
  return n;
}

export default function LivePlayer({
  cameraId,
  className,
  onState,
  fit = 'cover',
  onVideo,
}: {
  cameraId: string;
  className?: string;
  onState?: (s: LiveState) => void;
  fit?: 'cover' | 'contain';
  onVideo?: (el: HTMLVideoElement | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const setVideo = (el: HTMLVideoElement | null) => { videoRef.current = el; onVideo?.(el); };
  const boxRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LiveState>('idle');

  const report = (s: LiveState) => {
    setState(s);
    onState?.(s);
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    let alive = true;
    let wanted = false;
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let sessionToken = '';
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchTimer: ReturnType<typeof setInterval> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    let current: LiveState = 'idle';

    const set = (s: LiveState) => {
      if (!alive || s === current) return;
      current = s;
      reportRef.current(s);
    };

    function teardown() {
      generation++;
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (sessionUrl) {
        fetch(sessionUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` }, keepalive: true }).catch(() => {});
        sessionUrl = null;
      }
      if (pc) {
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
        pc = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    }

    function scheduleRetry() {
      if (!alive || !wanted || retryTimer) return;
      const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      const delay = base * (0.7 + Math.random() * 0.6);
      attempt++;
      set('reconnecting');
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    }

    async function connect() {
      teardown();
      const gen = generation;
      if (!alive || !wanted) return;
      set(attempt === 0 ? 'authorizing' : 'reconnecting');

      let session: Session;
      try {
        session = await requestSession(cameraId);
      } catch (e) {
        if (gen !== generation) return;
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 503) return set('unavailable');
        if (status === 401 || status === 403 || status === 404) {
          set('denied');
          retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 60000);
          return;
        }
        return scheduleRetry();
      }
      if (gen !== generation || !alive || !wanted) return;

      set('connecting');
      const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
      pc = peer;
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });
      peer.ontrack = ev => {
        const v = videoRef.current;
        if (v && ev.streams[0] && v.srcObject !== ev.streams[0]) v.srcObject = ev.streams[0];
      };
      peer.onconnectionstatechange = () => {
        if (gen !== generation) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') scheduleRetry();
      };

      try {
        await peer.setLocalDescription(await peer.createOffer());
        await gatheringDone(peer);
        if (gen !== generation) return;
        const res = await fetch(session.whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${session.token}` },
          body: peer.localDescription!.sdp,
        });
        if (gen !== generation) return;
        if (res.status === 401 || res.status === 403) {
          set('denied');
          retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 60000);
          return;
        }
        if (res.status === 404) { set('offline'); return scheduleRetry(); }
        if (res.status !== 201) throw new HttpError(res.status);
        const loc = res.headers.get('location');
        sessionUrl = loc ? new URL(loc, session.whepUrl).toString() : null;
        sessionToken = session.token;
        await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch {
        if (gen === generation) scheduleRetry();
        return;
      }

      // LIVE — только когда реально декодируются кадры, а не когда «соединилось»
      let lastFrames = 0;
      let lastChange = Date.now();
      watchTimer = setInterval(async () => {
        if (gen !== generation || !pc) return;
        const n = await framesDecoded(pc).catch(() => lastFrames);
        if (n > lastFrames) {
          lastFrames = n;
          lastChange = Date.now();
          if (current !== 'live') { attempt = 0; set('live'); }
        } else if (Date.now() - lastChange > STALL_MS) {
          if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
          set('offline');
          scheduleRetry();
        }
      }, 1000);
    }

    function want(on: boolean) {
      if (on === wanted) return;
      wanted = on;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (on) { attempt = 0; connect(); }
      else { teardown(); set('idle'); }
    }

    // смотрим только видимые плитки: в сетке 4×4 не держим 16 соединений впустую
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) want(!document.hidden);
      else if (wanted) hideTimer = setTimeout(() => want(false), HIDDEN_GRACE_MS);
    }, { threshold: 0.1 });
    if (boxRef.current) io.observe(boxRef.current);

    const onVisibility = () => {
      if (document.hidden) {
        if (wanted) hideTimer = setTimeout(() => want(false), HIDDEN_GRACE_MS);
      } else if (boxRef.current) {
        const r = boxRef.current.getBoundingClientRect();
        const onScreen = r.bottom > 0 && r.top < window.innerHeight;
        if (onScreen) want(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (hideTimer) clearTimeout(hideTimer);
      teardown();
    };
  }, [cameraId]);

  return (
    <div ref={boxRef} className={className}>
      <video
        ref={setVideo}
        autoPlay
        muted
        playsInline
        className={`w-full h-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} transition-opacity duration-300 ${state === 'live' ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
}
