import { createPrivateKey, createPublicKey, createHash, sign, randomUUID, type KeyObject } from 'crypto';

const ISSUER = 'safezone';
const AUDIENCE = 'mediamtx';

let cached: { privateKey: KeyObject; kid: string } | null = null;

function signingKey() {
  if (cached) return cached;
  const raw = process.env.MEDIA_JWT_PRIVATE_KEY;
  if (!raw) return null;
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const privateKey = createPrivateKey(pem);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { n: string; e: string };
  const kid = createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest('hex').slice(0, 16);
  cached = { privateKey, kid };
  return cached;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export const mediaPath = (cameraId: string) => 'cam_' + cameraId.replace(/-/g, '');

export function mediaBaseUrl() {
  return (process.env.MEDIA_PUBLIC_URL || '').replace(/\/$/, '');
}

export function mediaConfigured() {
  return Boolean(mediaBaseUrl() && signingKey());
}

export function viewerToken(cameraId: string, userId: string, ttlSec = 120) {
  const key = signingKey();
  if (!key) throw new Error('MEDIA_JWT_PRIVATE_KEY не задан');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: userId,
    iat: now,
    nbf: now - 5,
    exp: now + ttlSec,
    jti: randomUUID(),
    mediamtx_permissions: [{ action: 'read', path: mediaPath(cameraId) }],
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(sign('RSA-SHA256', Buffer.from(body), key.privateKey))}`;
}
