/**
 * Автопоиск камер: где искать и что добавлять.
 *
 * Перебираем только частные сети (10.x, 172.16–31.x, 192.168.x). Бридж на VPS
 * сидит в публичной сети хостинга — перебор «своей сети» там означал бы стучаться
 * к серверам чужих людей, за это хостинг блокирует машину.
 *
 * Регистратор отдаёт по два-три потока на канал. Берём один поток на канал:
 * H.264 — его понимают и браузер (LIVE), и детектор; среди них — самый крупный.
 * H.265 берём, только если другого нет, и честно помечаем.
 */

export function isPrivatePrefix(prefix) {
  const [a, b] = String(prefix).split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** «192.168.1, 192.168.2.0/24» → ['192.168.1', '192.168.2']; только частные, не больше четырёх. */
export function parseSubnets(input) {
  const out = [];
  for (const raw of String(input || '').split(/[\s,;]+/)) {
    const parts = raw.split('/')[0].split('.').filter(Boolean);
    if (parts.length < 3) continue;
    const oct = parts.slice(0, 3).map(Number);
    if (oct.some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
    const p = oct.join('.');
    if (isPrivatePrefix(p) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 4);
}

/** Куда смотреть: явно заданные сети → сеть объекта из панели → свои сети (только на месте, не на VPS). */
export function planTargets({ asked, site = [], serverMode = false, local = [] }) {
  const explicit = parseSubnets(asked);
  if (explicit.length) return { targets: explicit, source: 'указанная подсеть' };
  const siteNets = parseSubnets((site || []).join(','));
  if (siteNets.length) return { targets: siteNets, source: 'сеть объекта' };
  if (serverMode) return { targets: [], source: null };
  return { targets: (local || []).filter(isPrivatePrefix), source: 'сети бриджа' };
}

/** Номер канала из RTSP-пути разных производителей; null — одиночная камера. */
export function channelOf(path) {
  const s = String(path || '');
  let m = /[?&]channel=(\d+)/i.exec(s);
  if (m) return +m[1];
  m = /\/Streaming\/Channels\/(\d+)/i.exec(s);
  if (m) {
    const n = +m[1];
    return n >= 100 ? Math.floor(n / 100) : n;
  }
  m = /\/(?:ch|channel)(\d+)/i.exec(s);
  if (m) return +m[1];
  return null;
}

const pixels = r => {
  const m = /^(\d+)x(\d+)$/.exec(String(r || ''));
  return m ? +m[1] * +m[2] : 0;
};
const isH264 = e => /h\.?264|avc/i.test(String(e || ''));

/**
 * Одна камера на канал.
 * @param devices [{host, info, profiles:[{name, resolution, encoding, parsed:{ip,port,path}}], cred}]
 */
export function pickStreams(devices) {
  const out = [];
  for (const d of devices || []) {
    const groups = new Map();
    for (const p of d.profiles || []) {
      if (!p.parsed) continue;
      const ch = channelOf(p.parsed.path);
      const key = ch === null ? 'one' : ch;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...p, ch });
    }
    const channels = [...groups.keys()].filter(k => k !== 'one').length;
    for (const [, list] of groups) {
      const h264 = list.filter(p => isH264(p.encoding));
      const pool = h264.length ? h264 : list;
      const best = pool.reduce((a, b) => (pixels(b.resolution) > pixels(a.resolution) ? b : a));
      const brand = [d.info?.manufacturer, d.info?.model].filter(Boolean).join(' ') || 'Камера';
      out.push({
        host: d.host,
        ip: best.parsed.ip,
        port: best.parsed.port,
        path: best.parsed.path,
        channel: best.ch,
        name: best.ch !== null && channels > 1 ? `${brand} · канал ${best.ch}` : `${brand} · ${best.parsed.ip}`,
        resolution: best.resolution || null,
        encoding: best.encoding || null,
        browser_ok: isH264(best.encoding) || !best.encoding,
        cred: d.cred ?? 0,
      });
    }
  }
  return out.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }) || (a.channel ?? 0) - (b.channel ?? 0));
}
