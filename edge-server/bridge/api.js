// api.js — локальный HTTP-API бриджа (v7.6).
//
// Зачем: кнопки «Найти камеры» и «Проверить» в админке. Панель крутится на
// Vercel, но браузер оператора сидит на том же ПК, что и бридж, — значит может
// стучаться на localhost. Наружу порт не торчит (по умолчанию 127.0.0.1).
//
// Эндпоинты:
//   GET  /health                  — жив ли бридж, версия, статус
//   POST /discover {subnet,user,pass}  — ONVIF-поиск камер в сети
//   POST /probe {rtsp | ip,port,user,pass,path} — снять кадр и прогнать детектор

import { createServer } from 'http';
import { discoverCameras } from './onvif.js';

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readJson(req, limitBytes = 1e6) {
  let body = '', size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('тело запроса слишком велико');
    body += c;
  }
  return body ? JSON.parse(body) : {};
}

/**
 * @param {object} deps { version, log, grabSnapshot, detect, buildRtspUrl, getStatus }
 * @param {object} opts { port, host }
 */
export function startApi(deps, opts = {}) {
  const port = parseInt(opts.port || 8099);
  const host = opts.host || '127.0.0.1';
  const log = deps.log || console.log;

  let discovering = false; // защита от двойного нажатия: скан тяжёлый

  const srv = createServer(async (req, res) => {
    cors(res, req.headers.origin);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `http://${host}:${port}`);
    try {
      // ── здоровье ──
      if (url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          version: deps.version,
          uptime_sec: Math.round(process.uptime()),
          ...(deps.getStatus ? deps.getStatus() : {}),
        });
      }

      // ── поиск камер ONVIF ──
      if (url.pathname === '/discover' && req.method === 'POST') {
        if (discovering) return json(res, 429, { ok: false, error: 'поиск уже идёт, подожди' });
        discovering = true;
        const t0 = Date.now();
        try {
          const b = await readJson(req);
          const logs = [];
          log(`🔍 ONVIF-поиск запущен из админки${b.subnet ? ` (подсеть ${b.subnet}.x)` : ''}`);
          const cameras = await discoverCameras({
            subnet: b.subnet || null,
            user: b.user || 'admin',
            pass: b.pass || '',
            useMulticast: b.multicast !== false,
            onLog: m => { logs.push(m); log(`  🔍 ${m}`); },
          });
          // плоский список готовых к добавлению камер
          const suggestions = [];
          for (const c of cameras) {
            for (const p of c.profiles) {
              if (!p.parsed) continue;
              suggestions.push({
                host: c.host,
                manufacturer: c.info?.manufacturer || null,
                model: c.info?.model || null,
                profile: p.name,
                resolution: p.resolution,
                ip: p.parsed.ip,
                port: p.parsed.port,
                path: p.parsed.path,
                rtsp: p.rtsp,
                snapshot: p.snapshot || null,
                is_substream: /sub|second|minor|low/i.test(p.name) || /subtype=1|\/102|\/2$/.test(p.parsed.path),
              });
            }
          }
          log(`🔍 ONVIF-поиск завершён за ${((Date.now() - t0) / 1000).toFixed(1)}с: камер ${cameras.length}, профилей ${suggestions.length}`);
          return json(res, 200, { ok: true, cameras, suggestions, logs, took_sec: +((Date.now() - t0) / 1000).toFixed(1) });
        } finally { discovering = false; }
      }

      // ── проверка камеры: кадр + что видит детектор ──
      if (url.pathname === '/probe' && req.method === 'POST') {
        const b = await readJson(req);
        // без ip собирать адрес нельзя — получится мусор вида rtsp://undefined
        if (!b.rtsp && !b.ip) {
          return json(res, 400, { ok: false, error: 'нужен готовый rtsp или как минимум поле ip' });
        }
        const rtsp = b.rtsp || (deps.buildRtspUrl ? deps.buildRtspUrl(b) : null);
        if (!rtsp || /undefined|\/\/:/.test(rtsp)) {
          return json(res, 400, { ok: false, error: 'не удалось собрать RTSP-адрес из переданных полей' });
        }

        const t0 = Date.now();
        let buf;
        try {
          buf = await deps.grabSnapshot(rtsp, 'probe');
        } catch (e) {
          return json(res, 200, { ok: false, error: `кадр не получен: ${e.message}`, hint: 'проверь логин/пароль, включён ли RTSP, и не занят ли поток другим клиентом' });
        }
        let dets = [];
        try { dets = (await deps.detect(buf)) || []; } catch (e) { log(`probe detect: ${e.message}`); }

        return json(res, 200, {
          ok: true,
          took_sec: +((Date.now() - t0) / 1000).toFixed(1),
          size_kb: Math.round(buf.length / 1024),
          preview: 'data:image/jpeg;base64,' + buf.toString('base64'),
          detections: dets.map(d => ({ cls: d.cls, conf: +d.conf.toFixed(2) })),
          people: dets.filter(d => d.cls === 'person').length,
        });
      }

      // ── настройки функций: схема + текущие значения ──
      if (url.pathname === '/settings' && req.method === 'GET') {
        if (!deps.getSettings) return json(res, 501, { ok: false, error: 'настройки недоступны' });
        return json(res, 200, { ok: true, ...deps.getSettings() });
      }

      // ── перечитать настройки из БД сразу после сохранения в панели ──
      if (url.pathname === '/settings/reload' && req.method === 'POST') {
        if (deps.onSettingsSaved) await deps.onSettingsSaved();
        return json(res, 200, { ok: true, ...(deps.getSettings ? deps.getSettings() : {}) });
      }

      json(res, 404, { ok: false, error: 'нет такого эндпоинта' });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  srv.on('error', e => log(`⚠️ API не поднялся на ${host}:${port}: ${e.message}`));
  srv.listen(port, host, () => log(`🌐 API для админки: http://${host}:${port} (health / discover / probe)`));
  return srv;
}
