import { createPrivateKey, createPublicKey, createHash, sign, verify, randomUUID, timingSafeEqual } from 'crypto';

const ISSUER = 'safezone';
const AUDIENCE = 'mediamtx';
const PATH_PREFIX = 'cam_';

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function loadKey(pem) {
  if (!pem) return null;
  const text = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const isPrivate = /PRIVATE KEY/.test(text);
  const privateKey = isPrivate ? createPrivateKey(text) : null;
  const publicKey = isPrivate ? createPublicKey(privateKey) : createPublicKey(text);
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest('hex').slice(0, 16);
  return { privateKey, publicKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid };
}

export function jwks(key) {
  return { keys: key ? [key.jwk] : [] };
}

export function signJwt(key, { permissions, ttlSec = 120, sub = 'viewer' }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub,
    iat: now,
    nbf: now - 5,
    exp: now + ttlSec,
    jti: randomUUID(),
    mediamtx_permissions: permissions,
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(sign('RSA-SHA256', Buffer.from(body), key.privateKey))}`;
}

export function pathFor(cameraId) {
  return PATH_PREFIX + String(cameraId).replace(/-/g, '');
}

export function viewerToken(key, cameraId, ttlSec = 120) {
  return signJwt(key, { sub: 'viewer', ttlSec, permissions: [{ action: 'read', path: pathFor(cameraId) }] });
}

export function internalReadUrl(rtspBase, cameraId, secret) {
  const u = new URL(rtspBase);
  u.username = 'bridge';
  u.password = secret;
  u.pathname = '/' + pathFor(cameraId);
  return u.toString();
}

const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function verifyJwt(key, token, now = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') throw new Error('нет токена');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('токен повреждён');
  const header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('не тот алгоритм');
  if (header.kid && header.kid !== key.kid) throw new Error('чужой ключ');
  const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, fromB64url(parts[2]));
  if (!ok) throw new Error('подпись не сходится');
  const p = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  if (p.iss !== ISSUER || p.aud !== AUDIENCE) throw new Error('не тот издатель');
  if (typeof p.exp !== 'number' || p.exp < now) throw new Error('токен просрочен');
  if (typeof p.nbf === 'number' && p.nbf > now) throw new Error('токен ещё не действует');
  return p;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function tokenOf(req) {
  if (req.token) return req.token;
  if (req.password && req.password.split('.').length === 3) return req.password;
  const q = new URLSearchParams(req.query || '');
  return q.get('jwt') || '';
}

/**
 * Решение для MediaMTX (authMethod: http). Камеры мы забираем сами, поэтому
 * публикация запрещена всем. Браузер смотрит только по токену на конкретную
 * камеру, бридж читает RTSP только с этой же машины.
 */
export function authorize(req, { key, bridgeSecret }) {
  const local = LOOPBACK.has(req.ip);
  const action = req.action;

  if (action === 'api' || action === 'metrics' || action === 'pprof') {
    return local ? { allow: true } : { allow: false, reason: 'служебный доступ только с сервера' };
  }
  if (action === 'publish') return { allow: false, reason: 'публикация запрещена' };
  if (action !== 'read') return { allow: false, reason: `действие ${action} не разрешено` };

  if (req.protocol === 'rtsp') {
    if (!local) return { allow: false, reason: 'RTSP только для бриджа на сервере' };
    if (req.user === 'bridge' && sameSecret(req.password, bridgeSecret)) return { allow: true };
    return { allow: false, reason: 'неверный секрет бриджа' };
  }

  if (!key) return { allow: false, reason: 'ключ проверки не настроен' };
  try {
    const p = verifyJwt(key, tokenOf(req));
    const granted = (p.mediamtx_permissions || []).some(
      x => x.action === 'read' && (x.path === req.path || x.path === ''),
    );
    return granted ? { allow: true, sub: p.sub } : { allow: false, reason: 'нет прав на эту камеру' };
  } catch (e) {
    return { allow: false, reason: e.message };
  }
}

export class MediaSync {
  constructor({ apiBase, log = () => {}, closeAfter = '15s' }) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.log = log;
    this.closeAfter = closeAfter;
    this.known = new Map();
  }

  async #call(method, path, body) {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MediaMTX ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  desired(cameras, buildUrl) {
    const out = new Map();
    for (const cam of cameras) {
      if (!cam?.id || !cam.ip_address) continue;
      out.set(pathFor(cam.id), {
        source: buildUrl(cam),
        sourceOnDemand: true,
        sourceOnDemandStartTimeout: '10s',
        sourceOnDemandCloseAfter: this.closeAfter,
        rtspTransport: 'tcp',
      });
    }
    return out;
  }

  async sync(cameras, buildUrl) {
    const want = this.desired(cameras, buildUrl);
    const list = await this.#call('GET', '/v3/config/paths/list?itemsPerPage=1000');
    const have = new Map(
      (list?.items || [])
        .filter(p => p.name?.startsWith(PATH_PREFIX))
        .map(p => [p.name, p]),
    );

    const stats = { added: 0, updated: 0, removed: 0 };

    for (const [name, conf] of want) {
      const cur = have.get(name);
      if (!cur) {
        await this.#call('POST', `/v3/config/paths/add/${name}`, conf);
        stats.added++;
      } else if (cur.source !== conf.source || cur.sourceOnDemand !== true) {
        await this.#call('PATCH', `/v3/config/paths/patch/${name}`, conf);
        stats.updated++;
      }
    }

    for (const name of have.keys()) {
      if (!want.has(name)) {
        await this.#call('DELETE', `/v3/config/paths/delete/${name}`);
        stats.removed++;
      }
    }

    if (stats.added || stats.updated || stats.removed) {
      this.log(`LIVE: потоков +${stats.added} ~${stats.updated} -${stats.removed}, всего ${want.size}`);
    }
    return stats;
  }
}
