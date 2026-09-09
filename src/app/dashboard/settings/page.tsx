'use client';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/store/auth';
import { Bell, Send, CheckCircle, Brain, Zap, Sliders, Info } from 'lucide-react';
import toast from 'react-hot-toast';

export default function SettingsPage() {
  const { mall, profile } = useAuth();
  const [tg, setTg] = useState({ bot_token: '', chat_id: '' });
  const [ai, setAi] = useState({
    ai_enabled: true,
    ai_interval_sec: 15,
    ai_confidence: 0.5,
    ai_cooldown_sec: 60,
  });
  const [loading, setLoading] = useState(false);
  const [savingAi, setSavingAi] = useState(false);

  useEffect(() => {
    if (mall) loadAll();
  }, [mall]);

  const loadAll = async () => {
    const sb = createClient();
    const [tgRes, mallRes] = await Promise.all([
      sb.from('telegram_settings').select('*').eq('mall_id', mall!.id).maybeSingle(),
      sb.from('malls').select('ai_enabled, ai_interval_sec, ai_confidence, ai_cooldown_sec').eq('id', mall!.id).single(),
    ]);
    if (tgRes.data) setTg({ bot_token: tgRes.data.bot_token || '', chat_id: tgRes.data.chat_id || '' });
    if (mallRes.data) {
      setAi({
        ai_enabled: mallRes.data.ai_enabled ?? true,
        ai_interval_sec: mallRes.data.ai_interval_sec ?? 15,
        ai_confidence: mallRes.data.ai_confidence ?? 0.5,
        ai_cooldown_sec: mallRes.data.ai_cooldown_sec ?? 60,
      });
    }
  };

  const saveTg = async () => {
    setLoading(true);
    const sb = createClient();
    const { data: existing } = await sb.from('telegram_settings').select('id').eq('mall_id', mall?.id).maybeSingle();
    if (existing) {
      await sb.from('telegram_settings').update({ bot_token: tg.bot_token, chat_id: tg.chat_id }).eq('id', existing.id);
    } else {
      await sb.from('telegram_settings').insert({ mall_id: mall?.id, bot_token: tg.bot_token, chat_id: tg.chat_id });
    }
    toast.success('Telegram настроен');
    setLoading(false);
  };

  const testTg = async () => {
    if (!tg.bot_token || !tg.chat_id) {
      toast.error('Заполните токен и chat_id');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/notifications/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_token: tg.bot_token,
          chat_id: tg.chat_id,
          message: '🛡 SafeZone: Тестовое уведомление! Система настроена корректно.',
        }),
      });
      const data = await res.json();
      if (data.ok) toast.success('Тест отправлен!');
      else toast.error('Ошибка: ' + (data.error || 'не удалось'));
    } catch (e) {
      toast.error('Ошибка отправки');
    }
    setLoading(false);
  };

  const saveAi = async () => {
    if (!mall) return;
    setSavingAi(true);
    const sb = createClient();
    const { error } = await sb
      .from('malls')
      .update({
        ai_enabled: ai.ai_enabled,
        ai_interval_sec: ai.ai_interval_sec,
        ai_confidence: ai.ai_confidence,
        ai_cooldown_sec: ai.ai_cooldown_sec,
      })
      .eq('id', mall.id);
    if (error) toast.error('Ошибка: ' + error.message);
    else toast.success('Настройки AI сохранены. Перезапустите Bridge.');
    setSavingAi(false);
  };

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-white">Настройки</h1>
        <p className="text-slate-400 text-sm">Параметры системы безопасности</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Brain size={20} className="text-accent" />
            <h2 className="text-lg font-semibold text-white">AI-анализ камер</h2>
          </div>

          <div className="space-y-5">
            {}
            <div className="flex items-center justify-between p-3 rounded-xl bg-surface-200">
              <div>
                <p className="text-white font-medium">Авто-анализ AI</p>
                <p className="text-xs text-slate-500">AI проверяет каждый кадр на угрозы</p>
              </div>
              <button
                onClick={() => setAi(p => ({ ...p, ai_enabled: !p.ai_enabled }))}
                className={`relative w-12 h-6 rounded-full transition-all ${ai.ai_enabled ? 'bg-success' : 'bg-surface-300'}`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${ai.ai_enabled ? 'left-6' : 'left-0.5'}`}
                />
              </button>
            </div>

            {}
            <div>
              <label className="flex items-center gap-2 text-sm text-slate-400 mb-2">
                <Zap size={14} />
                Интервал анализа: <span className="text-white font-medium">{ai.ai_interval_sec} сек</span>
              </label>
              <input
                type="range"
                min={5}
                max={120}
                step={5}
                value={ai.ai_interval_sec}
                onChange={e => setAi(p => ({ ...p, ai_interval_sec: parseInt(e.target.value) }))}
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>5 сек (дорого)</span>
                <span>60 сек</span>
                <span>120 сек (экономно)</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Чем чаще — тем больше тревог, но и расход OpenAI выше. Рекомендуем 15-30 сек.
              </p>
            </div>

            {}
            <div>
              <label className="flex items-center gap-2 text-sm text-slate-400 mb-2">
                <Sliders size={14} />
                Чувствительность AI: <span className="text-white font-medium">{ai.ai_confidence.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min={0.3}
                max={0.8}
                step={0.05}
                value={ai.ai_confidence}
                onChange={e => setAi(p => ({ ...p, ai_confidence: parseFloat(e.target.value) }))}
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>0.3 (параноик)</span>
                <span>0.5</span>
                <span>0.8 (только явное)</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Чем ниже — тем больше тревог (включая ложные). 0.4 — параноидальный режим как в школах.
              </p>
            </div>

            {}
            <div>
              <label className="text-sm text-slate-400 mb-2 block">
                Пауза между одинаковыми тревогами: <span className="text-white font-medium">{ai.ai_cooldown_sec} сек</span>
              </label>
              <input
                type="range"
                min={30}
                max={300}
                step={30}
                value={ai.ai_cooldown_sec}
                onChange={e => setAi(p => ({ ...p, ai_cooldown_sec: parseInt(e.target.value) }))}
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>30 сек</span>
                <span>5 мин</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Не спамим Telegram повторными тревогами одного типа в течение этого времени.
              </p>
            </div>

            <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 flex gap-2 text-xs text-slate-300">
              <Info size={14} className="text-primary flex-shrink-0 mt-0.5" />
              <p>После сохранения настроек <b>перезапустите Bridge</b> на ноуте: <code className="text-accent">docker compose restart</code></p>
            </div>

            <Button onClick={saveAi} loading={savingAi}>
              <CheckCircle size={16} />Сохранить настройки AI
            </Button>
          </div>
        </Card>

        {}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Bell size={20} className="text-primary" />
            <h2 className="text-lg font-semibold text-white">Telegram уведомления</h2>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Bot Token</label>
              <input
                value={tg.bot_token}
                onChange={e => setTg(p => ({ ...p, bot_token: e.target.value }))}
                placeholder="123456:ABC-DEF..."
                className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white"
              />
              <p className="text-xs text-slate-500 mt-1">Получите токен у @BotFather</p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Chat ID</label>
              <input
                value={tg.chat_id}
                onChange={e => setTg(p => ({ ...p, chat_id: e.target.value }))}
                placeholder="123456789"
                className="w-full px-4 py-3 rounded-xl bg-surface-200 border border-surface-300 text-white"
              />
              <p className="text-xs text-slate-500 mt-1">Узнайте свой ID у @userinfobot</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={saveTg} loading={loading}>
                <CheckCircle size={16} />Сохранить
              </Button>
              <Button variant="ghost" onClick={testTg} loading={loading}>
                <Send size={16} />Тест
              </Button>
            </div>
          </div>
        </Card>

        {}
        <Card className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-white mb-4">Информация о ТРЦ</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-slate-400 text-xs">ТРЦ</p>
              <p className="text-white">{mall?.name}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs">Город</p>
              <p className="text-white">{mall?.city}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs">Адрес</p>
              <p className="text-white">{mall?.address}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs">Администратор</p>
              <p className="text-white">{profile?.full_name || profile?.username}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs">Роль</p>
              <p className="text-white">{profile?.role}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs">Версия</p>
              <p className="text-white">SafeZone v3.0</p>
            </div>
          </div>
        </Card>
      </div>
    </DashboardLayout>
  );
}
