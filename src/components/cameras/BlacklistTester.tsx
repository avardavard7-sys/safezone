'use client';

import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { createClient } from '@/lib/supabase/client';
import { Camera, ImagePlus, ScanFace, Square, Trash2, UserPlus } from 'lucide-react';

const MIN_FACE = 60;
const STORE_KEY = 'sz-face-test-refs';

type Ref = { id: string; label: string; emb: number[]; thumb: string; source: 'фото' | 'камера' | 'список' };
type Box = { x1: number; y1: number; x2: number; y2: number };
type FaceRes = { box: Box; small?: boolean; width?: number; best: { label: string; score: number } | null };

import { faceCall as call, faceReady as ensureReady, faceEngineStarted, grabPixels as grab, thumbJpeg as thumbOf } from '@/lib/face-worker-client';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export default function BlacklistTester() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const thrRef = useRef(0.45);
  const refsRef = useRef<Ref[]>([]);

  const [refs, setRefs] = useState<Ref[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState(0.45);
  const [faces, setFaces] = useState(0);
  const [ms, setMs] = useState(0);

  thrRef.current = threshold;
  refsRef.current = refs;

  // список фото переживает перезагрузку страницы — хранится только в этом браузере
  useEffect(() => {
    try { setRefs(JSON.parse(localStorage.getItem(STORE_KEY) || '[]')); } catch { setRefs([]); }
    setLoaded(true);
    return () => stop();
  }, []);
  // в поток список уходит только после запуска проверки: иначе первый же
  // заход на страницу запускал бы загрузку моделей
  const sendRefs = (list: Ref[]) => call({ type: 'refs', refs: list.map(r => ({ label: r.label, emb: r.emb })) });
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(refs)); } catch {}
    if (faceEngineStarted()) ensureReady().then(() => sendRefs(refs)).catch(() => {});
  }, [refs, loaded]);

  async function prepare() {
    if (!faceEngineStarted()) setStatus('Загружаю модели в фоне — страницей можно пользоваться…');
    await ensureReady();
    await sendRefs(refsRef.current);
    setStatus('');
  }

  async function enroll(frame: ReturnType<typeof grab>, label: string, source: Ref['source']) {
    const r = await call({ type: 'enroll', buffer: frame.buffer, width: frame.width, height: frame.height }, [frame.buffer]);
    if (r.type !== 'enrolled') { setStatus(`«${label}»: ${r.reason || r.message}`); return; }
    setRefs(list => [...list, { id: `${Date.now()}-${Math.random()}`, label, emb: r.emb, thumb: thumbOf(r.thumb), source }]);
    setStatus(`Добавлено: «${label}»`);
  }

  async function onFiles(files: FileList | null) {
    // список файлов живой: поле очищается сразу после выбора и опустошает его,
    // поэтому забираем файлы до первого ожидания
    const list = Array.from(files || []);
    if (!list.length) return;
    setBusy(true);
    try {
      await prepare();
      for (const f of list) {
        const bmp = await createImageBitmap(f);
        await enroll(grab(bmp, bmp.width, bmp.height, 1280), f.name.replace(/\.[^.]+$/, ''), 'фото');
      }
    } catch (e: any) { setStatus(`Ошибка: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function captureSelf() {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    setBusy(true);
    try { await enroll(grab(v, v.videoWidth, v.videoHeight, 1280), `Снимок ${new Date().toLocaleTimeString('ru-RU')}`, 'камера'); }
    finally { setBusy(false); }
  }

  async function loadRealList() {
    const { data, error } = await createClient().from('blacklist_entries').select('id,label,embedding,face_thumb').eq('status', 'ready');
    if (error) { setStatus(`Настоящий список недоступен: ${error.message}`); return; }
    const list = (data || []).filter((x: any) => Array.isArray(x.embedding) && x.embedding.length === 128);
    if (!list.length) { setStatus('В настоящем списке нет готовых записей (или нет прав администратора)'); return; }
    setRefs(r => [...r.filter(x => x.source !== 'список'), ...list.map((x: any) => ({
      id: x.id, label: x.label, emb: x.embedding as number[],
      thumb: x.face_thumb ? `data:image/jpeg;base64,${x.face_thumb}` : '', source: 'список' as const,
    }))]);
    setStatus(`Загружено из настоящего списка: ${list.length}`);
  }

  async function start() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = s;
      const v = videoRef.current!;
      v.srcObject = s;
      await v.play();
      setOn(true);
      await prepare();
      runningRef.current = true;
      loop();
    } catch (e: any) { setStatus(`Камера не включилась: ${e.message}`); stop(); }
  }

  function stop() {
    runningRef.current = false;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setOn(false);
    const c = overlayRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }

  async function loop() {
    while (runningRef.current) {
      const v = videoRef.current;
      if (!v?.videoWidth) { await pause(150); continue; }
      const frame = grab(v, v.videoWidth, v.videoHeight);
      const r = await call({ type: 'frame', buffer: frame.buffer, width: frame.width, height: frame.height, minFace: MIN_FACE }, [frame.buffer]);
      if (!runningRef.current) break;
      if (r.type === 'faces') {
        draw(r.faces, frame.scale);
        setFaces(r.faces.length);
        setMs(r.ms);
      }
      // отдаём поток странице: отрисовка и клики не ждут следующего кадра
      await pause(60);
    }
  }

  function draw(list: FaceRes[], scale: number) {
    const v = videoRef.current, c = overlayRef.current;
    if (!v || !c) return;
    c.width = v.clientWidth; c.height = v.clientHeight;
    const k = v.clientWidth / (v.videoWidth * scale);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const f of list) {
      const hit = f.best && f.best.score >= thrRef.current;
      const color = f.small ? '#94A3B8' : hit ? '#10B981' : '#EF4444';
      const text = f.small ? `мелкое лицо ${f.width} px`
        : f.best ? `${hit ? f.best.label : 'нет совпадения'} · ${Math.round(f.best.score * 100)}%` : 'список пуст';
      const x = f.box.x1 * k, y = f.box.y1 * k;
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.strokeRect(x, y, (f.box.x2 - f.box.x1) * k, (f.box.y2 - f.box.y1) * k);
      ctx.font = 'bold 15px sans-serif';
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = color; ctx.fillRect(x, y - 22, tw, 22);
      ctx.fillStyle = '#06081e'; ctx.fillText(text, x + 5, y - 6);
    }
  }

  return (
    <Card className="mt-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2"><ScanFace size={20} /> Проверка чёрного списка с камеры ноутбука</h2>
        <p className="text-sm text-slate-400 mt-1">
          Те же модели и алгоритм, что в бридже. Считается в фоновом потоке этого браузера — страница не замирает.
          Фото и лица никуда не отправляются; список тестовых фото хранится только в этом браузере.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white ${busy ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
          <ImagePlus size={16} /> Добавить фото
          <input type="file" accept="image/*" multiple className="hidden" onChange={e => { onFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <button onClick={loadRealList} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-200 text-white hover:bg-surface-300">
          <UserPlus size={16} /> Взять настоящий список объекта
        </button>
        {!on ? (
          <button onClick={start} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white"><Camera size={16} /> Включить камеру</button>
        ) : (
          <>
            <button disabled={busy} onClick={captureSelf} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-200 text-white hover:bg-surface-300 disabled:opacity-50"><UserPlus size={16} /> Снять себя в список</button>
            <button onClick={stop} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white"><Square size={16} /> Выключить</button>
          </>
        )}
        {refs.length > 0 && (
          <button onClick={() => setRefs([])} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-200 text-slate-300 hover:text-red-400"><Trash2 size={16} /> Очистить список</button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-slate-300">
          Порог совпадения
          <input type="range" min={0.3} max={0.7} step={0.01} value={threshold} onChange={e => setThreshold(+e.target.value)} />
          <span className="text-white font-mono">{Math.round(threshold * 100)}%</span>
        </label>
        <span className="text-slate-500">в бридже 45% · лица меньше {MIN_FACE} px не сравниваются</span>
        {on && <span className="text-slate-500">· лиц в кадре {faces} · кадр {ms} мс</span>}
      </div>

      {status && <div className="text-sm text-amber-300">{status}</div>}

      {refs.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {refs.map(r => (
            <div key={r.id} className="relative w-24 text-center">
              {r.thumb ? <img src={r.thumb} alt={r.label} className="w-24 h-24 rounded-lg object-cover" /> : <div className="w-24 h-24 rounded-lg bg-surface-300" />}
              <div className="text-xs text-white truncate mt-1" title={r.label}>{r.label}</div>
              <div className="text-[10px] text-slate-500">{r.source}</div>
              <button onClick={() => setRefs(x => x.filter(y => y.id !== r.id))}
                className="absolute top-1 right-1 p-1 rounded bg-black/60 text-slate-300 hover:text-red-400" aria-label="Убрать">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative max-w-3xl">
        <video ref={videoRef} muted playsInline className={`w-full rounded-xl bg-black ${on ? '' : 'hidden'}`} />
        <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      </div>
    </Card>
  );
}
