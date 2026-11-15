// netscan.js — поиск камер без ONVIF: опрос портов, разговор по RTSP,
// список устройств сети и автообъявления. Дополняет onvif.js, а не заменяет его.

import net from 'net';
import dgram from 'dgram';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';

export const RTSP_PORTS = [554, 8554];
export const ONVIF_PORTS = [80, 8000, 8080, 2020, 8899];
export const SCAN_PORTS = [554, 8554, 80, 8000, 8080, 2020, 8899, 37777, 34567];

export function tcpOpen(ip, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => end(true));
    s.once('timeout', () => end(false));
    s.once('error', () => end(false));
    s.connect(port, ip);
  });
}

/** Какие «камерные» порты открыты у каждого адреса подсети. Возвращает Map<ip, number[]>. */
export async function scanSubnet(prefix, { ports = SCAN_PORTS, concurrency = 128, timeoutMs = 700, from = 1, to = 254, onProgress } = {}) {
  const jobs = [];
  for (let i = from; i <= to; i++) for (const p of ports) jobs.push([`${prefix}.${i}`, p]);
  const found = new Map();
  let idx = 0, done = 0;
  async function worker() {
    while (idx < jobs.length) {
      const [ip, port] = jobs[idx++];
      if (await tcpOpen(ip, port, timeoutMs)) {
        if (!found.has(ip)) found.set(ip, []);
        found.get(ip).push(port);
      }
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  for (const list of found.values()) list.sort((a, b) => a - b);
  return found;
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export function parseAuthHeader(value) {
  const v = String(value || '');
  const scheme = /^\s*(\w+)/.exec(v)?.[1]?.toLowerCase() || '';
  const params = {};
  for (const m of v.matchAll(/(\w+)="?([^",]*)"?/g)) params[m[1].toLowerCase()] = m[2];
  return { scheme, ...params };
}

export function digestResponse({ user, pass, realm, nonce, method, uri }) {
  return md5(`${md5(`${user}:${realm}:${pass}`)}:${nonce}:${md5(`${method}:${uri}`)}`);
}

/** Одно соединение RTSP: запросы идут по нему подряд, как требует вход с подписью. */
export function rtspConnect(ip, port, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0), waiter = null, cseq = 0, closed = false;
    const fail = (e) => { closed = true; sock.destroy(); if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => fail(new Error('timeout')));
    sock.on('error', (e) => { fail(e); reject(e); });
    sock.on('close', () => { if (waiter) fail(new Error('соединение закрыто')); closed = true; });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const text = buf.toString('latin1');
      const headEnd = text.indexOf('\r\n\r\n');
      if (headEnd < 0 || !waiter) return;
      const head = text.slice(0, headEnd);
      const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] || 0);
      if (buf.length < headEnd + 4 + len) return;
      const body = buf.slice(headEnd + 4, headEnd + 4 + len).toString('utf8');
      buf = buf.slice(headEnd + 4 + len);
      const lines = head.split('\r\n');
      const status = Number(/^RTSP\/\d\.\d\s+(\d+)/.exec(lines[0])?.[1] || 0);
      const headers = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      const w = waiter; waiter = null; w.resolve({ status, headers, body });
    });
    sock.connect(port, ip, () => resolve({
      request(method, url, extra = {}) {
        if (closed) return Promise.reject(new Error('соединение закрыто'));
        return new Promise((res, rej) => {
          waiter = { resolve: res, reject: rej };
          const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${++cseq}`, 'User-Agent: SafeZone', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
          if (method === 'DESCRIBE') lines.push('Accept: application/sdp');
          sock.write(lines.join('\r\n') + '\r\n\r\n');
        });
      },
      close() { closed = true; sock.destroy(); },
    }));
  });
}

export function codecFromSdp(sdp) {
  const m = /a=rtpmap:\d+\s+(H26[45]|HEVC|JPEG|MP4V-ES)/i.exec(String(sdp || ''));
  if (!m) return null;
  const c = m[1].toUpperCase();
  return c === 'HEVC' ? 'H265' : c;
}

/**
 * Проверяет один путь RTSP с логином и паролем.
 * @returns {status, server, realm, codec} — status 200 значит поток есть, 401 — пароль не подошёл.
 */
export async function rtspDescribe(ip, port, path, user = '', pass = '', timeoutMs = 2500) {
  const url = `rtsp://${ip}:${port}${path}`;
  let conn;
  try {
    conn = await rtspConnect(ip, port, timeoutMs);
    let r = await conn.request('DESCRIBE', url);
    let realm = null;
    if (r.status === 401 && r.headers['www-authenticate']) {
      const a = parseAuthHeader(r.headers['www-authenticate']);
      realm = a.realm || null;
      const auth = a.scheme === 'digest'
        ? `Digest username="${user}", realm="${a.realm}", nonce="${a.nonce}", uri="${url}", response="${digestResponse({ user, pass, realm: a.realm, nonce: a.nonce, method: 'DESCRIBE', uri: url })}"`
        : `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      r = await conn.request('DESCRIBE', url, { Authorization: auth });
    }
    return { status: r.status, server: r.headers.server || null, realm, codec: r.status === 200 ? codecFromSdp(r.body) : null };
  } catch (e) {
    return { status: 0, server: null, realm: null, codec: null, error: e.message };
  } finally { if (conn) conn.close(); }
}

/** Как камера представляется сама, без пароля. */
export async function rtspHello(ip, port, timeoutMs = 2000) {
  let conn;
  try {
    conn = await rtspConnect(ip, port, timeoutMs);
    const r = await conn.request('OPTIONS', `rtsp://${ip}:${port}/`);
    return { ok: r.status > 0, server: r.headers.server || null, methods: r.headers.public || null };
  } catch { return { ok: false, server: null, methods: null }; }
  finally { if (conn) conn.close(); }
}

const OUI = {
  Hikvision: ['4419B6', 'C056E3', 'BCAD28', '4CBD8F', '2857BE', '54C415', 'A41437', '1868CB', 'C42F90'],
  Dahua: ['3CEF8C', '9002A9', '4C11BF', 'E0508B', '38AF29', 'A0BD1D', 'BC325F', '14A78B', '9C1463'],
  Axis: ['00408C', 'ACCC8E', 'B8A44F'],
};

/** Производитель по адресу устройства. Это подсказка, а не точное знание. */
export function vendorByMac(mac) {
  const p = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 6);
  if (p.length < 6) return null;
  for (const [vendor, list] of Object.entries(OUI)) if (list.includes(p)) return vendor;
  return null;
}

export function identifyBrand({ server = '', realm = '', ports = [], mac = null } = {}) {
  const s = `${server} ${realm}`.toLowerCase();
  if (/dahua|login to /.test(s) || ports.includes(37777)) return 'Dahua';
  if (/hikvision|hik|ip camera\(/.test(s)) return 'Hikvision';
  if (/tp-?link|tapo/.test(s)) return 'TP-Link';
  if (/uniview|unv/.test(s)) return 'Uniview';
  if (/axis/.test(s)) return 'Axis';
  if (ports.includes(34567)) return 'XM';
  return vendorByMac(mac);
}

const PATHS = {
  Dahua: ch => [`/cam/realmonitor?channel=${ch}&subtype=0`, `/cam/realmonitor?channel=${ch}&subtype=1`],
  Hikvision: ch => [`/Streaming/Channels/${ch}01`, `/Streaming/Channels/${ch}02`],
  'TP-Link': () => ['/stream1', '/stream2'],
  Uniview: () => ['/media/video1', '/media/video2'],
  Axis: () => ['/axis-media/media.amp'],
};
const GENERIC = ['/', '/stream1', '/live', '/h264', '/11', '/live/ch00_0', '/Streaming/Channels/101', '/cam/realmonitor?channel=1&subtype=0'];
const MULTI = new Set(['Dahua', 'Hikvision']);

/** Из основного и второго потока берём тот, что откроется в браузере: H.264, при равенстве — основной. */
function pickBest(list) {
  const ok = list.filter(x => x.status === 200);
  if (!ok.length) return null;
  return ok.find(x => x.codec === 'H264') || ok[0];
}

/**
 * Камеры, которые отвечают по RTSP. Форма результата та же, что у inspectDevices в onvif.js.
 * @param hosts Map<ip, number[]> открытые порты
 */
export async function findRtspCameras(hosts, logins, { onLog = () => {}, macs = new Map(), maxChannels = 64, timeoutMs = 2500, rtspPorts = RTSP_PORTS } = {}) {
  const out = [];
  for (const [ip, ports] of hosts) {
    const port = rtspPorts.find(p => ports.includes(p)) || ports.find(p => rtspPorts.includes(p));
    if (!port) continue;
    const hello = await rtspHello(ip, port, timeoutMs);
    if (!hello.ok) continue;
    const dev = { host: ip, serviceUrl: null, via: 'rtsp', info: { manufacturer: null, model: null }, profiles: [], error: null, cred: null };
    let brand = identifyBrand({ server: hello.server || '', ports, mac: macs.get(ip) });

    for (let i = 0; i < logins.length && dev.cred === null; i++) {
      const { user, pass } = logins[i];
      const candidates = [...new Set([...(brand && PATHS[brand] ? PATHS[brand](1) : []), ...GENERIC])];
      const tried = [];
      let denied = false;
      for (const path of candidates) {
        const r = await rtspDescribe(ip, port, path, user, pass, timeoutMs);
        if (!brand) brand = identifyBrand({ server: r.server || '', realm: r.realm || '', ports, mac: macs.get(ip) });
        if (r.status === 401 || r.status === 403) { denied = true; break; }
        tried.push({ path, ...r });
        if (r.status === 200 && !(brand && PATHS[brand])) break;
        if (r.status === 200 && tried.filter(x => x.status === 200).length >= 2) break;
      }
      if (denied) { dev.error = 'камера найдена, но логин или пароль не подошли'; continue; }
      const first = pickBest(tried);
      if (!first) { dev.error = 'камера найдена, но путь к видео определить не удалось'; continue; }
      dev.cred = i; dev.error = null;
      const mk = (x, ch) => ({ name: ch ? `Канал ${ch}` : 'Поток', rtsp: `rtsp://${ip}:${port}${x.path}`, resolution: null, encoding: x.codec, parsed: { ip, port, path: x.path } });
      dev.profiles.push(mk(first, MULTI.has(brand) ? 1 : null));
      if (MULTI.has(brand)) {
        let misses = 0;
        for (let ch = 2; ch <= maxChannels && misses < 2; ch++) {
          const got = [];
          for (const path of PATHS[brand](ch)) got.push({ path, ...(await rtspDescribe(ip, port, path, user, pass, timeoutMs)) });
          const best = pickBest(got);
          if (best) { dev.profiles.push(mk(best, ch)); misses = 0; } else misses++;
        }
      }
    }
    dev.info.manufacturer = brand || null;
    out.push(dev);
    onLog(`${ip}: ${dev.error ? '⚠ ' + dev.error : `${brand || 'камера'} по RTSP — потоков ${dev.profiles.length}`}`);
  }
  return out;
}

/** Список соседей из таблицы ARP: понимает вывод Linux, Windows и macOS. */
export function parseArpTable(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line)?.[1];
    const mac = /([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})/i.exec(line)?.[1];
    if (!ip || !mac) continue;
    const norm = mac.split(/[:-]/).map(x => x.padStart(2, '0')).join(':').toLowerCase();
    if (norm === '00:00:00:00:00:00' || norm === 'ff:ff:ff:ff:ff:ff') continue;
    out.push({ ip, mac: norm });
  }
  return out;
}

export function readArp() {
  return new Promise((resolve) => {
    try { return resolve(parseArpTable(readFileSync('/proc/net/arp', 'utf8'))); } catch {}
    execFile('arp', ['-a'], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? [] : parseArpTable(stdout)));
  });
}

export function parseSsdp(text, ip) {
  const h = {};
  for (const l of String(text || '').split(/\r?\n/).slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  return { ip, server: h.server || null, st: h.st || null, location: h.location || null };
}

/** Устройства, которые сами объявляют себя в сети. */
export function ssdpDiscover(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve([]); }
    sock.on('error', () => { try { sock.close(); } catch {} resolve([...found.values()]); });
    sock.on('message', (msg, rinfo) => { if (!found.has(rinfo.address)) found.set(rinfo.address, parseSsdp(msg.toString(), rinfo.address)); });
    const q = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
    sock.bind(() => {
      try { sock.send(q, 1900, '239.255.255.250'); } catch {}
      setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
    });
  });
}

const PRIVATE_PREFIX = /^(10\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3})$/;

/**
 * Камеры, которых не видно по ONVIF: открытые порты видео в частной сети → RTSP.
 * Чужие сети не трогаем: сканируются только частные диапазоны.
 * @param targets префиксы сетей вида '192.168.1'
 * @param skipHosts адреса, уже найденные по ONVIF
 */
export async function findWithoutOnvif({ targets = [], logins = [], skipHosts = new Set(), onLog = () => {}, scan = scanSubnet, arp = readArp, rtspPorts = RTSP_PORTS } = {}) {
  const nets = targets.filter(t => PRIVATE_PREFIX.test(String(t)));
  if (!nets.length || !logins.length) return [];
  const macs = new Map();
  try { for (const row of await arp()) macs.set(row.ip, row.mac); } catch {}
  const hosts = new Map();
  for (const net of nets) {
    onLog(`${net}.x: ищу камеры без ONVIF`);
    const found = await scan(net);
    for (const [ip, ports] of found) {
      if (skipHosts.has(ip)) continue;
      if (!ports.some(p => rtspPorts.includes(p))) continue;
      hosts.set(ip, ports);
    }
  }
  if (!hosts.size) return [];
  const cams = await findRtspCameras(hosts, logins, { onLog, macs, rtspPorts });
  onLog(`без ONVIF найдено: ${cams.length}`);
  return cams;
}
