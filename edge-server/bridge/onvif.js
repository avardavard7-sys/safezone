// onvif.js — автопоиск камер и получение RTSP-адресов по стандарту ONVIF (v7.6).
//
// Зачем: сейчас монтажник вручную ищет IP, гадает путь (/cam/realmonitor или
// /Streaming/Channels/101) и вбивает всё руками. С ONVIF камера САМА сообщает
// свой RTSP-адрес — независимо от бренда.
//
// Два способа поиска (второй — потому что первый не везде работает):
//  1) WS-Discovery: UDP multicast 239.255.255.250:3702 — быстро, находит всё,
//     но мультикаст часто режется в Docker Desktop на Windows/Mac.
//  2) TCP-развёртка подсети: на каждый IP шлём GetSystemDateAndTime (единственный
//     ONVIF-вызов БЕЗ авторизации). Медленнее, но работает всегда и везде.
//
// Без внешних зависимостей: dgram + fetch + crypto из ядра Node.

import dgram from 'dgram';
import { createHash, randomBytes } from 'crypto';
import { networkInterfaces } from 'os';

const ONVIF_PORTS = [80, 8000, 8080, 2020, 8899];
const SERVICE_PATHS = ['/onvif/device_service', '/onvif/services', '/onvif/Device'];

// ─────────────────────────── SOAP ───────────────────────────

/** WS-Security UsernameToken с дайджестом: Base64(SHA1(nonce + created + password)) */
export function wsSecurityHeader(user, pass, nonceB64 = null, created = null) {
  const nonce = nonceB64 ? Buffer.from(nonceB64, 'base64') : randomBytes(16);
  const ts = created || new Date().toISOString();
  const digest = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(ts, 'utf8'), Buffer.from(pass, 'utf8')]))
    .digest('base64');
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${esc(user)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${ts}</Created></UsernameToken></Security></s:Header>`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function soapEnvelope(body, auth = null) {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">${auth || ''}<s:Body>${body}</s:Body></s:Envelope>`;
}

/** Достаёт значение тега независимо от namespace-префикса (tt:, trt:, tds:...) */
export function pickTag(xml, tag) {
  const m = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`).exec(xml || '');
  return m ? m[1].trim() : null;
}

export function pickAllTags(xml, tag) {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml || ''))) out.push(m[1].trim());
  return out;
}

/** Токены профилей: атрибут token у <Profiles ...> */
export function pickProfileTokens(xml) {
  const re = /<(?:[A-Za-z0-9_.-]+:)?Profiles\b[^>]*\btoken="([^"]+)"/g;
  const out = []; let m;
  while ((m = re.exec(xml || ''))) out.push(m[1]);
  return out;
}

async function soapCall(url, body, auth, timeoutMs = 4000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: soapEnvelope(body, auth),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// ─────────────────────── Поиск камер ───────────────────────

/** Парсинг ответов WS-Discovery: адреса сервисов устройства */
export function parseProbeMatches(xml) {
  const addrs = [];
  for (const raw of pickAllTags(xml, 'XAddrs')) {
    for (const a of raw.split(/\s+/)) if (/^https?:\/\//i.test(a)) addrs.push(a);
  }
  return addrs;
}

/** WS-Discovery: UDP multicast. Может не работать в Docker Desktop (Windows/Mac). */
export function wsDiscover(timeoutMs = 3000) {
  return new Promise(resolve => {
    const found = new Set();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch { return resolve([]); }

    const uuid = `urn:uuid:${randomBytes(16).toString('hex')}`;
    const probe = `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>${uuid}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;

    sock.on('message', msg => parseProbeMatches(msg.toString()).forEach(a => found.add(a)));
    sock.on('error', () => { try { sock.close(); } catch {} resolve([...found]); });
    sock.bind(() => {
      try { sock.setBroadcast(true); sock.setMulticastTTL(4); } catch {}
      const buf = Buffer.from(probe);
      sock.send(buf, 3702, '239.255.255.250');
      setTimeout(() => sock.send(buf, 3702, '239.255.255.250'), 400); // второй заход: UDP теряется
      setTimeout(() => { try { sock.close(); } catch {} resolve([...found]); }, timeoutMs);
    });
  });
}

/** Жив ли ONVIF на этом адресе: GetSystemDateAndTime не требует авторизации */
export async function probeOnvif(ip, port, path, timeoutMs = 1500) {
  const url = `http://${ip}:${port}${path}`;
  try {
    const r = await soapCall(url, '<tds:GetSystemDateAndTime/>', null, timeoutMs);
    if (/GetSystemDateAndTimeResponse|SystemDateAndTime/i.test(r.text)) return url;
  } catch {}
  return null;
}

/** TCP-развёртка подсети — работает там, где мультикаст зарезан */
export async function sweepSubnet(subnetPrefix, { ports = ONVIF_PORTS, paths = SERVICE_PATHS, concurrency = 40, onProgress } = {}) {
  const ips = Array.from({ length: 254 }, (_, i) => `${subnetPrefix}.${i + 1}`);
  const found = [];
  let idx = 0, done = 0;

  async function worker() {
    while (idx < ips.length) {
      const ip = ips[idx++];
      outer:
      for (const port of ports) {
        for (const path of paths) {
          const url = await probeOnvif(ip, port, path);
          if (url) { found.push(url); break outer; }
        }
      }
      if (onProgress) onProgress(++done, ips.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

// ──────────────── Данные камеры и RTSP-адрес ────────────────

/** Информация об устройстве (нужны логин/пароль) */
export async function getDeviceInfo(serviceUrl, user, pass) {
  const r = await soapCall(serviceUrl, '<tds:GetDeviceInformation/>', wsSecurityHeader(user, pass));
  if (/NotAuthorized|Sender not Authorized|authentication/i.test(r.text)) throw new Error('неверный логин или пароль');
  return {
    manufacturer: pickTag(r.text, 'Manufacturer'),
    model: pickTag(r.text, 'Model'),
    firmware: pickTag(r.text, 'FirmwareVersion'),
    serial: pickTag(r.text, 'SerialNumber'),
  };
}

/** Адрес медиа-сервиса (может отличаться от device_service) */
export async function getMediaServiceUrl(serviceUrl, user, pass) {
  try {
    const r = await soapCall(serviceUrl, '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>', wsSecurityHeader(user, pass));
    const media = /<(?:[A-Za-z0-9_.-]+:)?Media\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?Media>/.exec(r.text);
    const xaddr = media && pickTag(media[0], 'XAddr');
    if (xaddr) return xaddr;
  } catch {}
  return serviceUrl.replace(/\/onvif\/.*$/, '/onvif/media_service');
}

/**
 * Главное: RTSP-адреса всех профилей камеры (основной поток и субпоток).
 * @returns {Promise<Array<{token, name, resolution, rtsp, snapshot}>>}
 */
export async function getStreamProfiles(serviceUrl, user, pass) {
  const mediaUrl = await getMediaServiceUrl(serviceUrl, user, pass);
  const pr = await soapCall(mediaUrl, '<trt:GetProfiles/>', wsSecurityHeader(user, pass));
  if (/NotAuthorized|Sender not Authorized/i.test(pr.text)) throw new Error('неверный логин или пароль');

  const tokens = pickProfileTokens(pr.text);
  const blocks = (pr.text.match(/<(?:[A-Za-z0-9_.-]+:)?Profiles\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?Profiles>/g) || []);
  const out = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const blk = blocks[i] || '';
    const w = pickTag(blk, 'Width'), h = pickTag(blk, 'Height');

    let rtsp = null, snapshot = null;
    try {
      const sr = await soapCall(mediaUrl,
        `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetStreamUri>`,
        wsSecurityHeader(user, pass));
      rtsp = pickTag(sr.text, 'Uri');
    } catch {}
    try {
      const nr = await soapCall(mediaUrl,
        `<trt:GetSnapshotUri><trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetSnapshotUri>`,
        wsSecurityHeader(user, pass));
      snapshot = pickTag(nr.text, 'Uri');
    } catch {}

    out.push({
      token,
      name: pickTag(blk, 'Name') || token,
      resolution: w && h ? `${w}x${h}` : null,
      rtsp,
      snapshot,
    });
  }
  return out;
}

/** Подставляет логин/пароль в URL: rtsp://host/path → rtsp://user:pass@host/path */
export function withCredentials(url, user, pass) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pass);
    return u.toString();
  } catch { return url; }
}

/** Разбирает RTSP-адрес на поля для админки (host, port, path) */
export function splitRtsp(url) {
  try {
    const u = new URL(url);
    return {
      ip: u.hostname,
      port: u.port ? parseInt(u.port) : 554,
      path: (u.pathname || '') + (u.search || ''),
    };
  } catch { return null; }
}

/**
 * Полный цикл: найти камеры и вытащить их RTSP-адреса.
 * @param {object} opts { subnet, user, pass, useMulticast, onLog }
 */

/**
 * Приводит что угодно к префиксу /24: '192.168.10.8', '192.168.10.0/24'
 * и '192.168.10' дают одинаковый '192.168.10'.
 * Раньше полный адрес приклеивался как есть и развёртка шла по
 * '192.168.10.8.1-254' — несуществующим адресам, поэтому не находила ничего.
 */
export function normalizeSubnet(input) {
  if (!input) return null;
  const parts = String(input).trim().split('/')[0].split('.').filter(Boolean);
  if (parts.length < 3) return null;
  const octets = parts.slice(0, 3).map(Number);
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets.join('.');
}

/** Подсети собственных интерфейсов — там, где бридж реально стоит. */
export function localSubnets() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const sub = normalizeSubnet(i.address);
      // 172.17/172.18 — внутренние сети докера, камер там не бывает
      if (sub && !sub.startsWith('172.17.') && !sub.startsWith('172.18.') && !out.includes(sub)) out.push(sub);
    }
  }
  return out;
}

export async function discoverCameras({ subnet, user = 'admin', pass = '', useMulticast = true, onLog = () => {} } = {}) {
  let services = [];

  if (useMulticast) {
    onLog('WS-Discovery (multicast)…');
    services = await wsDiscover();
    onLog(`multicast нашёл: ${services.length}`);
  }
  if (!services.length) {
    const asked = normalizeSubnet(subnet);
    if (subnet && !asked) onLog(`подсеть «${subnet}» не разобрана, ищу по своим сетям`);
    // Без явной подсети ищем там, где стоит сам бридж, а не по адресам из базы.
    const targets = asked ? [asked] : localSubnets();
    if (!targets.length) onLog('не нашёл ни одной своей сети — укажи подсеть вручную');

    for (const net of targets) {
      onLog(`развёртка подсети ${net}.1-254 (мультикаст пуст или зарезан)…`);
      const found = await sweepSubnet(net, {
        onProgress: (d, t) => { if (d % 50 === 0) onLog(`проверено ${d}/${t}`); },
      });
      onLog(`${net}.x → найдено ${found.length}`);
      services.push(...found);
      if (found.length) break;
    }
  }

  // дедуп по хосту
  const byHost = new Map();
  for (const s of services) {
    try { byHost.set(new URL(s).hostname, s); } catch {}
  }

  const cameras = [];
  for (const [host, serviceUrl] of byHost) {
    const cam = { host, serviceUrl, info: null, profiles: [], error: null };
    try {
      cam.info = await getDeviceInfo(serviceUrl, user, pass);
      cam.profiles = await getStreamProfiles(serviceUrl, user, pass);
      for (const p of cam.profiles) {
        p.rtsp_with_auth = withCredentials(p.rtsp, user, pass);
        p.parsed = splitRtsp(p.rtsp);
      }
    } catch (e) {
      cam.error = e.message;
    }
    cameras.push(cam);
    onLog(`${host}: ${cam.error ? '⚠ ' + cam.error : (cam.info?.manufacturer || '?') + ' ' + (cam.info?.model || '') + ' — профилей ' + cam.profiles.length}`);
  }
  return cameras;
}
