'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { CameraDiscovery } from '@/components/cameras/CameraDiscovery';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Plus, Camera as CamIcon, Trash2, RefreshCw, Edit2, Info, Brain } from 'lucide-react';
import toast from 'react-hot-toast';
import LiveCamera from '@/components/cameras/LiveCamera';

const RTSP_PRESETS: Record<string, (channel: number) => string> = {
  hikvision: (ch) => `/Streaming/Channels/${ch}01`,
  dahua: (ch) => `/cam/realmonitor?channel=${ch}&subtype=0`,
  tapo: () => `/stream1`,
  reolink: () => `/h264Preview_01_main`,
  xiaomi: () => `/live/ch00_0`,
  custom: () => '',
};

const PRESET_LABELS: Record<string, string> = {
  hikvision: 'Hikvision (камера или NVR)',
  dahua: 'Dahua (камера или NVR)',
  tapo: 'TP-Link Tapo C200/C210',
  reolink: 'Reolink',
  xiaomi: 'Xiaomi / Mi Camera',
  custom: 'Другая (ввести вручную)',
};

const SCENARIOS: { key: string; label: string; icon: string; desc: string }[] = [
  { key: 'fire', label: 'Огонь и дым', icon: '🔥', desc: 'Пламя, зажигалки, задымление' },
  { key: 'weapon', label: 'Оружие', icon: '🔪', desc: 'Ножи, ножницы, огнестрел, острые предметы' },
  { key: 'fight', label: 'Драки и агрессия', icon: '👊', desc: 'Удары, замахи, нападение' },
  { key: 'theft', label: 'Кражи', icon: '💰', desc: 'Сокрытие предметов, кража денег' },
  { key: 'fall', label: 'Падение человека', icon: '🤕', desc: 'Человек упал или лежит' },
  { key: 'smoking', label: 'Курение и вейпы', icon: '🚬', desc: 'Сигареты, вейпы, кальян' },
  { key: 'intrusion', label: 'Проникновение', icon: '🚷', desc: 'Посторонние в запретной зоне, периметр' },
  { key: 'crowd', label: 'Скопление людей', icon: '👥', desc: 'Очереди, толпа, паника' },
  { key: 'child_lost', label: 'Потерянный ребёнок', icon: '🧒', desc: 'Ребёнок без взрослых рядом' },
  { key: 'suspicious', label: 'Брошенные предметы', icon: '🎒', desc: 'Оставленные сумки, подозрительное' },
];
const ALL_SCENARIO_KEYS = SCENARIOS.map(s => s.key);

const Field = ({ label, hint, children }: any) => (
  <div>
    <label className="block text-xs text-slate-400 mb-1">{label}</label>
    {children}
    {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
  </div>
);

export default function CamerasPage() {
  const { mall } = useAuth();
  const [cameras, setCameras] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [preset, setPreset] = useState<string>('hikvision');
  const [channel, setChannel] = useState<string>('1');
  const [form, setForm] = useState({
    name: '', ip_address: '', port: '554', username: 'admin', password: '',
    rtsp_path: '/Streaming/Channels/101', zone_id: '', floor: '1', ai_enabled: true,
    enabled_scenarios: [...ALL_SCENARIO_KEYS] as string[],
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (mall) { loadCameras(); loadZones(); } }, [mall]);

  useEffect(() => {
    if (preset === 'custom') return;
    const ch = Math.max(1, parseInt(channel) || 1);
    const path = RTSP_PRESETS[preset]?.(ch) || '';
    setForm(p => ({ ...p, rtsp_path: path }));
  }, [preset, channel]);

  const loadCameras = async () => {
    const sb = createClient();
    const { data } = await sb.from('cameras').select('*').eq('mall_id', mall?.id).order('created_at');
    setCameras(data || []);
  };

  const loadZones = async () => {
    const sb = createClient();
    const { data } = await sb.from('zones').select('*').eq('mall_id', mall?.id).order('floor, name');
    setZones(data || []);
  };

  const resetForm = () => {
    setForm({ name: '', ip_address: '', port: '554', username: 'admin', password: '', rtsp_path: '/Streaming/Channels/101', zone_id: '', floor: '1', ai_enabled: true, enabled_scenarios: [...ALL_SCENARIO_KEYS] });
    setPreset('hikvision');
    setChannel('1');
    setEditing(null);
    setShowAdd(false);
  };

  const addCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const sb = createClient();
    const data = {
      mall_id: mall?.id,
      name: form.name,
      ip_address: form.ip_address,
      port: parseInt(form.port),
      username: form.username,
      password: form.password,
      rtsp_path: form.rtsp_path,
      zone_id: form.zone_id || null,
      floor: parseInt(form.floor),
      is_active: true,
      ai_enabled: form.ai_enabled,
      enabled_scenarios: form.enabled_scenarios,
    };
    if (editing) {
      await sb.from('cameras').update(data).eq('id', editing.id);
      toast.success('Камера обновлена');
    } else {
      await sb.from('cameras').insert(data);
      toast.success('Камера добавлена. Подождите 5-10 секунд для появления картинки.');
    }
    resetForm();
    loadCameras();
    setLoading(false);
  };

  const editCamera = (cam: any) => {
    setEditing(cam);
    setForm({
      name: cam.name || '',
      ip_address: cam.ip_address || '',
      port: String(cam.port || 554),
      username: cam.username || 'admin',
      password: cam.password || '',
      rtsp_path: cam.rtsp_path || '/Streaming/Channels/101',
      zone_id: cam.zone_id || '',
      floor: String(cam.floor || 1),
      ai_enabled: cam.ai_enabled ?? true,
      enabled_scenarios: Array.isArray(cam.enabled_scenarios) ? cam.enabled_scenarios : [...ALL_SCENARIO_KEYS],
    });
    setPreset('custom');
    setShowAdd(true);
  };

  const deleteCamera = async (id: string) => {
    if (!confirm('Удалить камеру?')) return;
    const sb = createClient();
    await sb.from('cameras').delete().eq('id', id);
    toast.success('Удалена');
    loadCameras();
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Камеры</h1>
          <p className="text-slate-400 text-sm">{cameras.length} камер</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={loadCameras}><RefreshCw size={16} />Обновить</Button>
          <Button onClick={() => { resetForm(); setShowAdd(true); }}><Plus size={16} />Добавить</Button>
        </div>
      </div>

      <CameraDiscovery
        onAdd={(cam) => {
          setPreset('custom');
          setForm(p => ({
            ...p,
            name: cam.name,
            ip_address: cam.ip_address,
            port: String(cam.port),
            username: cam.username,
            password: cam.password,
            rtsp_path: cam.rtsp_path,
          }));
          setEditing(null);
          setShowAdd(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      {showAdd && (
        <Card className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">{editing ? 'Редактировать камеру' : 'Новая камера'}</h2>

          {!editing && (
            <div className="mb-5 p-4 rounded-xl bg-primary/5 border border-primary/20 flex gap-3">
              <Info size={18} className="text-primary flex-shrink-0 mt-0.5" />
              <div className="text-sm text-slate-300 space-y-1">
                <p><b>Если у вас NVR (видеорегистратор)</b> — указывайте IP регистратора и номер канала камеры.</p>
                <p><b>Если отдельная IP-камера</b> — IP самой камеры и номер канала 1.</p>
              </div>
            </div>
          )}

          <form onSubmit={addCamera} className="grid grid-cols-2 gap-4">
            <Field label="Название камеры">
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Главный вход" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" required />
            </Field>

            <Field label="Зона">
              <select value={form.zone_id} onChange={e => setForm(p => ({ ...p, zone_id: e.target.value }))} className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white">
                <option value="">Без зоны</option>
                {zones.map(z => <option key={z.id} value={z.id}>{z.name} (этаж {z.floor})</option>)}
              </select>
            </Field>

            <Field label="IP-адрес" hint="IP регистратора (NVR) или отдельной камеры">
              <input value={form.ip_address} onChange={e => setForm(p => ({ ...p, ip_address: e.target.value }))} placeholder="10.60.220.10" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" required />
            </Field>

            <Field label="Порт" hint="Обычно 554">
              <input value={form.port} onChange={e => setForm(p => ({ ...p, port: e.target.value }))} type="number" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            </Field>

            <Field label="Логин">
              <input value={form.username} onChange={e => setForm(p => ({ ...p, username: e.target.value }))} placeholder="admin" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            </Field>

            <Field label="Пароль">
              <input value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} type="password" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            </Field>

            <Field label="Производитель / тип" hint="RTSP-путь подставится автоматически">
              <select value={preset} onChange={e => setPreset(e.target.value)} className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white">
                {Object.entries(PRESET_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </Field>

            {(preset === 'hikvision' || preset === 'dahua') && (
              <Field label="Номер канала в NVR" hint="1, 2, 3... До 22 для вашего регистратора">
                <input value={channel} onChange={e => setChannel(e.target.value)} type="number" min="1" max="64" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
              </Field>
            )}

            <div className="col-span-2">
              <Field
                label="RTSP-путь"
                hint={preset === 'custom' ? 'Введите вручную' : 'Сгенерирован автоматически по производителю и каналу. Можно изменить вручную.'}
              >
                <input
                  value={form.rtsp_path}
                  onChange={e => { setPreset('custom'); setForm(p => ({ ...p, rtsp_path: e.target.value })); }}
                  placeholder="/Streaming/Channels/101"
                  className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white font-mono text-sm"
                />
              </Field>
            </div>

            <Field label="Этаж">
              <input value={form.floor} onChange={e => setForm(p => ({ ...p, floor: e.target.value }))} type="number" className="w-full px-4 py-2 rounded-xl bg-surface-200 border border-surface-300 text-white" />
            </Field>

            <div className="col-span-2 mt-2 p-3 rounded-lg bg-surface-200/50 text-xs text-slate-400 font-mono">
              Полный RTSP URL: <span className="text-white">rtsp://{form.username || 'admin'}:***@{form.ip_address || 'IP'}:{form.port}{form.rtsp_path}</span>
            </div>

            <div className="col-span-2 flex items-center justify-between p-3 rounded-xl bg-accent/5 border border-accent/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center">
                  <Brain size={18} className="text-accent" />
                </div>
                <div>
                  <p className="text-white font-medium text-sm">Авто-анализ AI</p>
                  <p className="text-xs text-slate-500">AI будет анализировать кадры этой камеры</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, ai_enabled: !p.ai_enabled }))}
                className={`relative w-12 h-6 rounded-full transition-all ${form.ai_enabled ? 'bg-success' : 'bg-surface-300'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${form.ai_enabled ? 'left-6' : 'left-0.5'}`} />
              </button>
            </div>

            {form.ai_enabled && (
              <div className="col-span-2 p-4 rounded-xl bg-surface-200/40 border border-surface-300">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-white font-medium text-sm">Какие угрозы отслеживать на этой камере</p>
                    <p className="text-xs text-slate-500">Отметьте сценарии — система будет реагировать только на выбранные</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setForm(p => ({ ...p, enabled_scenarios: [...ALL_SCENARIO_KEYS] }))} className="text-xs px-2 py-1 rounded-lg bg-surface-300 text-slate-300 hover:text-white transition-colors">Все</button>
                    <button type="button" onClick={() => setForm(p => ({ ...p, enabled_scenarios: [] }))} className="text-xs px-2 py-1 rounded-lg bg-surface-300 text-slate-300 hover:text-white transition-colors">Снять</button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {SCENARIOS.map(sc => {
                    const checked = form.enabled_scenarios.includes(sc.key);
                    return (
                      <button
                        key={sc.key}
                        type="button"
                        onClick={() => setForm(p => ({
                          ...p,
                          enabled_scenarios: checked
                            ? p.enabled_scenarios.filter(k => k !== sc.key)
                            : [...p.enabled_scenarios, sc.key],
                        }))}
                        className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${checked ? 'bg-accent/10 border-accent/40' : 'bg-surface-200/50 border-surface-300 opacity-60 hover:opacity-100'}`}
                      >
                        <div className={`mt-0.5 w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-all ${checked ? 'bg-accent' : 'bg-surface-300'}`}>
                          {checked && <span className="text-white text-xs">✓</span>}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-white font-medium flex items-center gap-1.5"><span>{sc.icon}</span>{sc.label}</p>
                          <p className="text-xs text-slate-500 truncate">{sc.desc}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-500 mt-3">Выбрано угроз: <span className="text-accent font-medium">{form.enabled_scenarios.length}</span> из {ALL_SCENARIO_KEYS.length}</p>
              </div>
            )}

            <div className="col-span-2 flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={resetForm}>Отмена</Button>
              <Button type="submit" loading={loading}>{editing ? 'Сохранить' : 'Добавить'}</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cameras.map(c => (
          <div key={c.id} className="glass-card overflow-hidden">
            <LiveCamera cameraId={c.id} cameraName={c.name} showInfo={false} />
            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium text-white truncate">{c.name}</h3>
                <StatusBadge status={c.status} />
              </div>
              <div className="text-xs text-slate-500 space-y-0.5 mb-3">
                <p>IP: {c.ip_address}:{c.port}</p>
                <p className="truncate" title={c.rtsp_path}>Путь: <span className="font-mono">{c.rtsp_path}</span></p>
                <p>Этаж: {c.floor}</p>
                <p className="flex items-center gap-1.5 mt-1">
                  <Brain size={12} className={c.ai_enabled !== false ? 'text-success' : 'text-slate-600'} />
                  <span className={c.ai_enabled !== false ? 'text-success' : 'text-slate-600'}>
                    {c.ai_enabled !== false ? 'AI активен' : 'AI выключен'}
                  </span>
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => editCamera(c)} className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-surface-200 text-slate-300 hover:bg-surface-300 flex items-center justify-center gap-1">
                  <Edit2 size={12} />Изменить
                </button>
                <button onClick={() => deleteCamera(c.id)} className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-danger/10 text-danger hover:bg-danger/20 flex items-center justify-center gap-1">
                  <Trash2 size={12} />Удалить
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {cameras.length === 0 && !showAdd && (
        <Card className="text-center py-12">
          <CamIcon className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400 mb-3">Камеры не добавлены</p>
          <Button onClick={() => setShowAdd(true)}><Plus size={16} />Добавить первую камеру</Button>
        </Card>
      )}
    </DashboardLayout>
  );
}
