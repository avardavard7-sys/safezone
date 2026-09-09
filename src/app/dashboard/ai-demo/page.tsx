'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SeverityBadge } from '@/components/ui/Badge';
import { Play, Square, Webcam as WebcamIcon, Brain, AlertTriangle, Settings, CheckCircle, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '@/store/auth';

export default function AIDemoPage() {
  const { mall } = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [autoMode, setAutoMode] = useState(false);
  const [interval_, setInterval_] = useState(10);

  const startCamera = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        toast.error('Браузер не поддерживает getUserMedia');
        return;
      }
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      setStream(s);
      toast.success('Камера включена');
    } catch (e: any) {
      console.error('getUserMedia error:', e);
      const name = e?.name || '';
      if (name === 'NotAllowedError') toast.error('Доступ к камере запрещён в браузере');
      else if (name === 'NotFoundError') toast.error('Камера не найдена');
      else if (name === 'NotReadableError') toast.error('Камера занята другим приложением');
      else toast.error('Не удалось включить камеру');
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.play().catch((e) => console.error('video.play() failed:', e));
  }, [stream]);

  const stopCamera = () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
    setAutoMode(false);
  };

  const analyze = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !stream) {
      toast.error('Сначала включите камеру');
      return;
    }
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      console.warn('Video not ready yet');
      return;
    }
    setAnalyzing(true);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setAnalyzing(false); return; }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64,
          camera_name: 'Вебкамера (AI Тест)',
          zone: 'AI Демо',
          floor: 1,
          mall_id: mall?.id,
        }),
      });
      const data = await res.json();
      setResults(prev => [{
        ...data,
        timestamp: new Date().toISOString(),
        id: Date.now(),
      }, ...prev].slice(0, 10));
      if (data.detected) {
        toast.error(`⚠️ ${data.description}`, { duration: 5000 });
      } else {
        toast.success('Всё спокойно', { duration: 2000 });
      }
    } catch (e) { toast.error('Ошибка анализа'); }
    setAnalyzing(false);
  }, [stream]);

  useEffect(() => {
    if (!autoMode || !stream) return;
    const int = setInterval(() => {
      analyze();
    }, interval_ * 1000);
    return () => clearInterval(int);
  }, [autoMode, stream, interval_, analyze]);

  useEffect(() => {
    return () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
    };

  }, []);

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-white">Тест AI (вебкамера)</h1>
        <p className="text-slate-400 text-sm">Проверьте работу AI через вебкамеру вашего компьютера</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <WebcamIcon size={20} className="text-primary" />
            Видео с вебкамеры
          </h2>
          <div className="relative aspect-video bg-surface-300 rounded-xl overflow-hidden mb-4">
            {}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />

            {!stream && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-300">
                <WebcamIcon className="w-16 h-16 text-slate-600 mb-3" />
                <p className="text-slate-500 mb-1">Камера выключена</p>
                <p className="text-xs text-slate-600">Нажмите "Включить камеру"</p>
              </div>
            )}

            {stream && analyzing && (
              <div className="absolute top-3 right-3 flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/20 backdrop-blur-sm">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs text-primary font-medium">AI анализирует...</span>
              </div>
            )}

            {stream && autoMode && (
              <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded-full bg-success/20 backdrop-blur-sm">
                <div className="w-2 h-2 rounded-full bg-success pulse-green" />
                <span className="text-xs text-success font-medium">АВТО каждые {interval_}с</span>
              </div>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />

          <div className="flex flex-wrap gap-2">
            {!stream ? (
              <Button onClick={startCamera}><Play size={16} />Включить камеру</Button>
            ) : (
              <>
                <Button variant="danger" onClick={stopCamera}><Square size={16} />Выключить</Button>
                <Button onClick={analyze} loading={analyzing}><Brain size={16} />Проверить сейчас</Button>
                <Button variant={autoMode ? 'accent' : 'ghost'} onClick={() => setAutoMode(!autoMode)}>
                  {autoMode ? '⏸ Остановить авто' : '▶ Запустить авто'}
                </Button>
              </>
            )}
          </div>

          {stream && (
            <div className="mt-4 p-4 rounded-xl bg-surface-200/50">
              <label className="text-xs text-slate-400 block mb-2 flex items-center gap-1.5">
                <Settings size={14} />
                Интервал авто-анализа: <strong className="text-white">{interval_} секунд</strong>
              </label>
              <input
                type="range"
                min="3"
                max="60"
                value={interval_}
                onChange={e => setInterval_(parseInt(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>3 сек</span>
                <span>30 сек</span>
                <span>60 сек</span>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Brain size={20} className="text-accent" />
            Результаты AI
          </h2>
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {results.length === 0 ? (
              <div className="text-center py-8">
                <AlertTriangle className="w-10 h-10 text-slate-600 mx-auto mb-2" />
                <p className="text-sm text-slate-500">Нет результатов</p>
                <p className="text-xs text-slate-600 mt-1">Включите камеру и нажмите "Проверить"</p>
              </div>
            ) : (
              results.map(r => (
                <div key={r.id} className="p-3 rounded-xl bg-surface-200">
                  <div className="flex items-center justify-between mb-1">
                    {r.detected ? <SeverityBadge severity={r.severity} /> : <span className="text-xs flex items-center gap-1 text-success"><CheckCircle size={12} />Норма</span>}
                    <span className="text-xs text-slate-500">{new Date(r.timestamp).toLocaleTimeString('ru-RU')}</span>
                  </div>
                  <p className="text-sm text-white">{r.description || 'Ничего подозрительного'}</p>
                  <div className="flex items-center gap-3 mt-1">
                    {typeof r.people_count === 'number' && (
                      <span className="text-xs text-slate-400 flex items-center gap-1">
                        <Users size={12} />{r.people_count} чел.
                      </span>
                    )}
                    {r.confidence && <span className="text-xs text-slate-500">Точность: {Math.round(r.confidence * 100)}%</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </DashboardLayout>
  );
}
