'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import LiveCamera from '@/components/cameras/LiveCamera';
import { Grid, LayoutGrid, Square, Maximize2, RefreshCw, Camera as CamIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type GridSize = 1 | 4 | 9 | 16;

export default function MonitoringPage() {
  const { mall } = useAuth();
  const [cameras, setCameras] = useState<any[]>([]);
  const [gridSize, setGridSize] = useState<GridSize>(4);
  const [loading, setLoading] = useState(true);
  const [selectedCamera, setSelectedCamera] = useState<any | null>(null);

  useEffect(() => {
    if (mall) loadCameras();
  }, [mall]);

  const loadCameras = async () => {
    setLoading(true);
    const sb = createClient();
    const { data } = await sb.from('cameras').select('*').eq('mall_id', mall?.id).order('created_at');
    setCameras(data || []);
    setLoading(false);
  };

  const grids: Record<GridSize, string> = {
    1: 'grid-cols-1',
    4: 'grid-cols-1 md:grid-cols-2',
    9: 'grid-cols-2 md:grid-cols-3',
    16: 'grid-cols-2 md:grid-cols-4',
  };

  const visibleCameras = cameras.slice(0, gridSize);

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Живой мониторинг</h1>
          <p className="text-slate-400 text-sm">Камеры в реальном времени • {cameras.length} камер</p>
        </div>
        <div className="flex gap-2">
          {[
            { size: 1 as GridSize, icon: Square, label: '1×1' },
            { size: 4 as GridSize, icon: Grid, label: '2×2' },
            { size: 9 as GridSize, icon: LayoutGrid, label: '3×3' },
            { size: 16 as GridSize, icon: LayoutGrid, label: '4×4' },
          ].map(g => (
            <button
              key={g.size}
              onClick={() => setGridSize(g.size)}
              className={cn('px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2', gridSize === g.size ? 'bg-primary text-white' : 'bg-surface-200 text-slate-400 hover:bg-surface-300')}
            >
              <g.icon size={16} />
              {g.label}
            </button>
          ))}
          <Button variant="ghost" onClick={loadCameras}><RefreshCw size={16} />Обновить</Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-12 h-12 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : cameras.length === 0 ? (
        <Card className="text-center py-20">
          <CamIcon className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">Нет добавленных камер</h3>
          <p className="text-slate-400 mb-4">Добавьте первую камеру в разделе «Камеры»</p>
          <a href="/dashboard/cameras"><Button>Перейти к камерам</Button></a>
        </Card>
      ) : (
        <div className={cn('grid gap-4', grids[gridSize])}>
          {visibleCameras.map(cam => (
            <LiveCamera
              key={cam.id}
              cameraId={cam.id}
              cameraName={cam.name}
              onClick={() => setSelectedCamera(cam)}
            />
          ))}
        </div>
      )}

      {}
      {selectedCamera && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-6" onClick={() => setSelectedCamera(null)}>
          <div className="w-full max-w-6xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-2xl font-display font-bold text-white">{selectedCamera.name}</h2>
                <p className="text-sm text-slate-400">{selectedCamera.ip_address} • Этаж {selectedCamera.floor}</p>
              </div>
              <Button variant="ghost" onClick={() => setSelectedCamera(null)}>Закрыть</Button>
            </div>
            <LiveCamera cameraId={selectedCamera.id} cameraName={selectedCamera.name} className="w-full" showInfo={false} />
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
