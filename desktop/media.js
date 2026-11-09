// Локальный видеосервер приложения: ключ подписи, секрет и настройки MediaMTX.
// Все порты слушают только этот компьютер: наружу видео не уходит.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORTS = { api: 9997, rtsp: 8554, webrtc: 8889, ice: 8189 };

/** Ключ подписи пропусков и секрет бриджа: создаются один раз и остаются на этом компьютере. */
function ensureMediaSecrets(dir) {
  const keyFile = path.join(dir, 'media-key.pem');
  const secretFile = path.join(dir, 'media-secret');
  let pem = null;
  try { pem = fs.readFileSync(keyFile, 'utf8'); crypto.createPrivateKey(pem); } catch { pem = null; }
  if (!pem) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(keyFile, pem, { mode: 0o600 });
  }
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  return { privateKeyPem: pem, secret };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

/** Настройки MediaMTX: права решает бридж, порты только на 127.0.0.1. */
function mediamtxConfig({ bridgeApiPort = 8099, origins = [], ports = PORTS } = {}) {
  const allowed = [...new Set(origins.map(originOf).filter(Boolean))];
  return [
    'logLevel: warn',
    'logDestinations: [stdout]',
    'readTimeout: 10s',
    'writeTimeout: 10s',
    'writeQueueSize: 512',
    'authMethod: http',
    `authHTTPAddress: http://127.0.0.1:${bridgeApiPort}/media/auth`,
    'authHTTPExclude: []',
    'api: true',
    `apiAddress: 127.0.0.1:${ports.api}`,
    'metrics: false',
    'pprof: false',
    'playback: false',
    'rtsp: true',
    'rtspTransports: [tcp]',
    `rtspAddress: 127.0.0.1:${ports.rtsp}`,
    'rtspEncryption: "no"',
    'rtspAuthMethods: [basic]',
    'rtmp: false',
    'hls: false',
    'srt: false',
    'moq: false',
    'webrtc: true',
    `webrtcAddress: 127.0.0.1:${ports.webrtc}`,
    'webrtcEncryption: false',
    `webrtcAllowOrigins: ${JSON.stringify(allowed)}`,
    'webrtcTrustedProxies: []',
    `webrtcLocalUDPAddress: 127.0.0.1:${ports.ice}`,
    `webrtcLocalTCPAddress: 127.0.0.1:${ports.ice}`,
    'webrtcIPsFromInterfaces: false',
    'webrtcAdditionalHosts: ["127.0.0.1"]',
    'webrtcHandshakeTimeout: 10s',
    'webrtcTrackGatherTimeout: 2s',
    'pathDefaults:',
    '  source: publisher',
    '  sourceOnDemand: false',
    '  sourceOnDemandStartTimeout: 10s',
    '  sourceOnDemandCloseAfter: 15s',
    '  rtspTransport: tcp',
    'paths:',
    '  all_others:',
    '',
  ].join('\n');
}

/** Переменные окружения бриджа для работы через локальный видеосервер. */
function bridgeMediaEnv({ secrets, ports = PORTS, dashboardUrl = '' }) {
  return {
    MEDIA_MODE: 'server',
    MEDIA_API: `http://127.0.0.1:${ports.api}`,
    MEDIA_RTSP: `rtsp://127.0.0.1:${ports.rtsp}`,
    MEDIA_WHEP_URL: `http://127.0.0.1:${ports.webrtc}`,
    MEDIA_BRIDGE_SECRET: secrets.secret,
    MEDIA_JWT_PRIVATE_KEY: secrets.privateKeyPem,
    ...(originOf(dashboardUrl) ? { PANEL_ORIGINS: originOf(dashboardUrl) } : {}),
  };
}

module.exports = { PORTS, ensureMediaSecrets, mediamtxConfig, bridgeMediaEnv, originOf };
