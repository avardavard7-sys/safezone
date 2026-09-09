// commands.js — очередь команд «панель → бридж» (v7.9).
//
// Зачем: браузер клиента не может стучаться на http://127.0.0.1 с https-страницы
// (mixed content), а давать клиенту исходники панели, чтобы поднять её локально,
// невозможно. Поэтому связь идёт через Supabase, который бридж и так опрашивает:
//
//   панель  ──insert──▶  bridge_commands (pending)
//   бридж   ──poll────▶  берёт, выполняет, пишет result
//   панель  ──select──▶  показывает результат
//
// Работает из облачной панели, по https, с телефона. Настройка сети не нужна.
//
// Безопасность: в params команды probe приходит пароль камеры. Сразу после
// выполнения бридж затирает params — пароль не залёживается в базе.

const MAX_RUNTIME_MS = 180000; // страховка: зависшая команда не блокирует очередь

/**
 * @param {object} deps { sb, mallId, log, discoverCameras, grabSnapshot, detect, buildRtspUrl }
 */
export function createCommandRunner(deps) {
  const { sb, mallId, log } = deps;
  let busy = false;
  let tableMissing = false;

  async function fail(id, message) {
    await sb.from('bridge_commands').update({
      status: 'error', error: String(message).slice(0, 500),
      params: {}, finished_at: new Date().toISOString(),
    }).eq('id', id);
  }

  async function runDiscover(cmd) {
    const p = cmd.params || {};
    const logs = [];
    const cameras = await deps.discoverCameras({
      subnet: p.subnet || null,
      user: p.user || 'admin',
      pass: p.pass || '',
      useMulticast: p.multicast !== false,
      onLog: m => { logs.push(m); log(`  🔍 ${m}`); },
    });

    const suggestions = [];
    for (const c of cameras) {
      for (const prof of c.profiles) {
        if (!prof.parsed) continue;
        suggestions.push({
          host: c.host,
          manufacturer: c.info?.manufacturer || null,
          model: c.info?.model || null,
          profile: prof.name,
          resolution: prof.resolution,
          ip: prof.parsed.ip,
          port: prof.parsed.port,
          path: prof.parsed.path,
          is_substream: /sub|second|minor|low/i.test(prof.name) || /subtype=1|\/102|\/2$/.test(prof.parsed.path),
        });
      }
      if (c.error) logs.push(`${c.host}: ${c.error}`);
    }
    return { suggestions, logs, cameras_found: cameras.length };
  }

  async function runProbe(cmd) {
    const p = cmd.params || {};
    const rtsp = p.rtsp || deps.buildRtspUrl({
      ip: p.ip, port: p.port || 554,
      username: p.username || p.user || 'admin',
      password: p.password || p.pass || '',
      rtsp_path: p.path || p.rtsp_path,
    });
    if (!rtsp || /undefined/.test(rtsp)) throw new Error('не хватает данных для RTSP-адреса');

    const buf = await deps.grabSnapshot(rtsp, 'cmd-probe');
    let dets = [];
    try { dets = (await deps.detect(buf)) || []; } catch {}

    return {
      size_kb: Math.round(buf.length / 1024),
      preview: 'data:image/jpeg;base64,' + buf.toString('base64'),
      detections: dets.map(d => ({ cls: d.cls, conf: +d.conf.toFixed(2) })),
      people: dets.filter(d => d.cls === 'person').length,
    };
  }

  /** Забирает одну команду и выполняет. Вызывается из основного цикла бриджа. */
  async function tick() {
    if (busy || tableMissing || !mallId) return;
    busy = true;
    try {
      const { data, error } = await sb
        .from('bridge_commands')
        .select('*')
        .eq('mall_id', mallId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        if (/relation|does not exist|schema cache|PGRST20/i.test(error.message || '')) {
          tableMissing = true;
          log('📮 Таблицы bridge_commands нет — команды из панели недоступны. Применить MIGRATION-v7.9-commands.sql');
        }
        return;
      }
      const cmd = data?.[0];
      if (!cmd) return;

      log(`📮 Команда из панели: ${cmd.kind}`);
      await sb.from('bridge_commands')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', cmd.id);

      const started = Date.now();
      let result;
      try {
        const work = cmd.kind === 'discover' ? runDiscover(cmd)
                   : cmd.kind === 'probe'    ? runProbe(cmd)
                   : Promise.reject(new Error(`неизвестная команда: ${cmd.kind}`));
        result = await Promise.race([
          work,
          new Promise((_, rej) => setTimeout(() => rej(new Error('превышено время выполнения')), MAX_RUNTIME_MS)),
        ]);
      } catch (e) {
        log(`📮 Команда ${cmd.kind} не выполнена: ${e.message}`);
        await fail(cmd.id, e.message);
        return;
      }

      // params затираем: там мог быть пароль камеры
      await sb.from('bridge_commands').update({
        status: 'done',
        result,
        params: {},
        finished_at: new Date().toISOString(),
      }).eq('id', cmd.id);
      log(`📮 Команда ${cmd.kind} выполнена за ${((Date.now() - started) / 1000).toFixed(1)}с`);
    } catch (e) {
      log(`📮 Ошибка обработки команд: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  return { tick, isBusy: () => busy };
}
