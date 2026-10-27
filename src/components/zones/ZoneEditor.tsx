'use client';

/**
 * Редактор зон внутри панели.
 *
 * Загружаешь кадр с камеры, кликаешь по углам зоны, сохраняешь — правила уходят
 * в Supabase, бридж подхватывает их сам. Копировать JSON руками не нужно.
 *
 * Вся геометрия и сборка правил вынесены в @/lib/zones/editor — там чистые
 * функции, покрытые тестами. Здесь только отрисовка и работа с холстом.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Upload, Trash2, Undo2, Save, Download, AlertTriangle, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  DrawnZone, ZoneKind, Point, KIND_LABELS, KIND_COLORS,
  validateZones, buildZonesJson, parseZonesJson, polygonArea,
} from '@/lib/zones/editor';

type Camera = { id: string; name: string };

export function ZoneEditor() {
  const { mall } = useAuth();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [zones, setZones] = useState<DrawnZone[]>([]);
  const [pts, setPts] = useState<Point[]>([]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ZoneKind>('zone');
  const [cameraName, setCameraName] = useState('');
  const [seconds, setSeconds] = useState(300);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const issues = validateZones(zones);
  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');

  useEffect(() => { if (mall?.id) { loadCameras(); loadSaved(); } }, [mall?.id]);

  async function loadCameras() {
    const sb = createClient();
    const { data } = await sb.from('cameras').select('id,name').eq('mall_id', mall?.id).order('name');
    setCameras(data || []);
    if (data?.length && !cameraName) setCameraName(data[0].name);
  }

  async function loadSaved() {
    const sb = createClient();
    const { data } = await sb.from('zone_rules').select('config').eq('mall_id', mall?.id).maybeSingle();
    const parsed = parseZonesJson(data?.config);
    if (parsed.length) { setZones(parsed); toast.success(`Загружено зон: ${parsed.length}`); }
  }

  const loadImage = useCallback((src: string) => {
    const im = new Image();
    im.onload = () => setImg(im);
    im.onerror = () => toast.error('Не удалось открыть изображение');
    im.src = src;
  }, []);

  function readFile(f: File) {
    if (!f.type.startsWith('image/')) { toast.error('Нужен файл изображения'); return; }
    const r = new FileReader();
    r.onload = e => loadImage(e.target?.result as string);
    r.readAsDataURL(f);
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) readFile(f); }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadImage]);

  // отрисовка холста
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !img) return;
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);

    const drawPoly = (points: Point[], color: string, label: string, closed: boolean) => {
      if (points.length < 2) return;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = p.x * cv.width, y = p.y * cv.height;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      if (closed) ctx.closePath();
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, cv.width / 500); ctx.stroke();
      if (closed) { ctx.fillStyle = color + '33'; ctx.fill(); }
      if (label) {
        const fs = Math.max(14, cv.width / 60);
        ctx.font = `bold ${fs}px sans-serif`;
        ctx.fillStyle = color;
        ctx.fillText(label, points[0].x * cv.width + 6, points[0].y * cv.height - 8);
      }
    };

    // только зоны выбранной камеры — чужие мешали бы
    zones.filter(z => z.cameraName === cameraName)
         .forEach(z => drawPoly(z.points, KIND_COLORS[z.kind], z.name, true));
    drawPoly(pts, '#FFD166', '', false);
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x * cv.width, p.y * cv.height, Math.max(5, cv.width / 250), 0, Math.PI * 2);
      ctx.fillStyle = '#FFD166'; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }, [img, zones, pts, cameraName]);

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const cv = canvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    setPts(p => [...p, {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    }]);
  }

  function saveZone() {
    if (pts.length < 3) { toast.error('Нужно минимум 3 точки'); return; }
    if (!name.trim()) { toast.error('Впиши название зоны'); return; }
    if (!cameraName) { toast.error('Выбери камеру'); return; }
    if (polygonArea(pts) < 0.002) toast('Зона очень маленькая — детектор может её не поймать', { icon: '⚠️' });

    setZones(z => [...z, {
      id: `z${Date.now()}`, name: name.trim(), kind, cameraName, seconds, points: pts,
    }]);
    setPts([]);
    toast.success(`Зона «${name.trim()}» добавлена`);
  }

  async function saveAll() {
    if (errors.length) { toast.error('Сначала исправь ошибки'); return; }
    setSaving(true);
    try {
      const sb = createClient();
      const { data: { user } } = await sb.auth.getUser();
      const config = buildZonesJson(zones);
      const { error } = await sb.from('zone_rules').upsert({
        mall_id: mall?.id, config, updated_at: new Date().toISOString(), updated_by: user?.id,
      }, { onConflict: 'mall_id' });
      if (error) throw new Error(error.message);
      toast.success(`Сохранено правил: ${config.rules.length}. Бридж подхватит их в течение минуты`);
    } catch (e: any) {
      toast.error(
        /relation|does not exist|schema cache/i.test(e.message)
          ? 'В базе нет таблицы zone_rules — выполни миграцию'
          : `Не сохранилось: ${e.message}`
      );
    } finally { setSaving(false); }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(buildZonesJson(zones), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zones.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const zonesHere = zones.filter(z => z.cameraName === cameraName);

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-5 items-start">
      <div>
        {!img ? (
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}
            className={`glass-card flex flex-col items-center justify-center text-center cursor-pointer py-20 px-8 border-2 border-dashed transition-all ${dragOver ? 'border-primary bg-primary/5' : 'border-surface-300'}`}
          >
            <Upload className="w-10 h-10 text-slate-500 mb-3" />
            <p className="text-white font-medium">Перетащи сюда кадр с камеры</p>
            <p className="text-sm text-slate-400 mt-1">или кликни и выбери файл · можно вставить из буфера Ctrl+V</p>
            <p className="text-xs text-slate-500 mt-3 max-w-md">
              Кадр можно взять из тревоги в Telegram, из скриншота VLC
              или кнопкой «Проверить» на странице камер
            </p>
          </div>
        ) : (
          <Card className="p-3">
            <canvas ref={canvasRef} onClick={onCanvasClick}
              className="w-full rounded-xl cursor-crosshair block" />
            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
              <p className="text-xs text-slate-400">
                {pts.length > 0
                  ? `Точек: ${pts.length}${pts.length >= 3 ? ' — можно сохранять зону' : ' (нужно минимум 3)'}`
                  : `Кликай по углам зоны. Зон на этой камере: ${zonesHere.length}`}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPts(p => p.slice(0, -1))} disabled={!pts.length}>
                  <Undo2 className="w-4 h-4" /> Точку назад
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setImg(null); setPts([]); }}>
                  Другой кадр
                </Button>
              </div>
            </div>
          </Card>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) readFile(f); }} />

        <div className="glass-card p-4 mt-4 text-sm text-slate-400 space-y-2">
          <p className="flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <span>Точки ставь <b className="text-white">по полу</b>, а не по головам: система смотрит, где человек стоит.</span>
          </p>
          <p className="flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <span>Для правила «сотрудника нет на месте» нужны <b className="text-white">две зоны с одинаковым названием</b>: гостей и персонала.</span>
          </p>
          <p className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-warning shrink-0" />
            <span>Разные зоны <b className="text-white">не должны накладываться</b> — иначе гость за столом посчитается ещё и гостем у стойки.</span>
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <Card>
          <h3 className="text-white font-medium mb-3">Новая зона</h3>
          <div className="space-y-3">
            <L label="Камера">
              <select value={cameraName} onChange={e => setCameraName(e.target.value)} className={inp}>
                {!cameras.length && <option value="">Нет камер — добавь их сначала</option>}
                {cameras.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </L>
            <L label="Название">
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Барная стойка · Стол 1" className={inp} />
            </L>
            <L label="Тип зоны">
              <select value={kind} onChange={e => setKind(e.target.value as ZoneKind)} className={inp}>
                {(Object.keys(KIND_LABELS) as ZoneKind[]).map(k =>
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </L>
            <L label="Секунд до тревоги">
              <input type="number" value={seconds} min={5} max={7200}
                onChange={e => setSeconds(parseInt(e.target.value) || 300)} className={inp} />
            </L>
            <Button onClick={saveZone} disabled={pts.length < 3} className="w-full justify-center">
              Сохранить зону
            </Button>
          </div>
        </Card>

        {zones.length > 0 && (
          <Card>
            <h3 className="text-white font-medium mb-3">Нарисовано ({zones.length})</h3>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {zones.map(z => (
                <div key={z.id} className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-surface-200">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">
                      <span style={{ color: KIND_COLORS[z.kind] }}>■</span> {z.name}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {z.cameraName} · {KIND_LABELS[z.kind].split(' (')[0]} · {z.seconds}с
                    </p>
                  </div>
                  <button onClick={() => setZones(list => list.filter(x => x.id !== z.id))}
                    className="text-slate-500 hover:text-danger shrink-0" title="Удалить зону">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {(errors.length > 0 || warnings.length > 0) && (
          <Card>
            {errors.map((i, n) => (
              <p key={`e${n}`} className="text-sm text-danger flex items-start gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{i.text}
              </p>
            ))}
            {warnings.map((i, n) => (
              <p key={`w${n}`} className="text-sm text-warning flex items-start gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{i.text}
              </p>
            ))}
          </Card>
        )}

        <div className="flex gap-2">
          <Button onClick={saveAll} loading={saving} disabled={!zones.length || errors.length > 0}
            className="flex-1 justify-center">
            <Save className="w-4 h-4" /> Сохранить всё
          </Button>
          <Button variant="ghost" onClick={downloadJson} disabled={!zones.length} title="Скачать zones.json">
            <Download className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const inp = 'w-full px-3 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white text-sm focus:border-primary focus:outline-none';
const L = ({ label, children }: any) => (
  <div>
    <label className="block text-xs text-slate-400 mb-1">{label}</label>
    {children}
  </div>
);

export default ZoneEditor;
