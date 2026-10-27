import { generateKeyPairSync } from 'crypto';
import {
  loadKey, jwks, signJwt, verifyJwt, viewerToken, pathFor, internalReadUrl, authorize, MediaSync,
} from './media.js';

let passed = 0, failed = 0;
const out = [];
const t = (name, fn) => {
  try { fn(); passed++; out.push(`  ok   ${name}`); }
  catch (e) { failed++; out.push(`  FAIL ${name}\n         ${e.message}`); }
};
const eq = (a, b, w = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`);
};
const yes = (c, w) => { if (!c) throw new Error(w || 'не выполнено'); };
const throws = (fn, part) => {
  try { fn(); } catch (e) { if (!e.message.includes(part)) throw new Error(`ждал «${part}», получил «${e.message}»`); return; }
  throw new Error(`ждал ошибку «${part}»`);
};

const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const PRIV = pem();
const priv = loadKey(PRIV);
const pub = loadKey(priv.publicKey.export({ type: 'spki', format: 'pem' }));
const evil = loadKey(pem());
const CAM = '11111111-aaaa-4aaa-8aaa-111111111111';
const OTHER = '22222222-bbbb-4bbb-8bbb-222222222222';
const SECRET = 'b7f0c2a94e1d83f6a5c0e29b7d41f8a3';
const ctx = { key: pub, bridgeSecret: SECRET };
const req = (o) => ({ ip: '203.0.113.7', user: '', password: '', token: '', action: 'read', path: pathFor(CAM), protocol: 'webrtc', query: '', ...o });

console.log('\n=== LIVE: ключи, токены, права ===\n');

t('kid совпадает у приватного и публичного ключа', () => eq(pub.kid, priv.kid));
t('kid разный у разных ключей', () => yes(pub.kid !== evil.kid));
t('ключ из .env с \\n вместо переносов читается', () => {
  eq(loadKey(PRIV.replace(/\n/g, '\\n')).kid, priv.kid);
});
t('JWKS отдаёт ровно один публичный ключ с kid', () => {
  const k = jwks(pub).keys;
  eq(k.length, 1); eq(k[0].kid, pub.kid); yes(!k[0].d, 'в JWKS утёк приватный ключ');
});

t('подписанный токен проверяется публичным ключом', () => {
  const p = verifyJwt(pub, viewerToken(priv, CAM));
  eq(p.mediamtx_permissions, [{ action: 'read', path: pathFor(CAM) }]);
});
t('просроченный токен отклоняется', () => {
  throws(() => verifyJwt(pub, signJwt(priv, { ttlSec: -10, permissions: [] })), 'просрочен');
});
t('токен чужим ключом отклоняется', () => throws(() => verifyJwt(pub, viewerToken(evil, CAM)), 'чужой ключ'));
t('подделанная полезная нагрузка отклоняется', () => {
  const [h, , s] = viewerToken(priv, CAM).split('.');
  const forged = Buffer.from(JSON.stringify({ iss: 'safezone', aud: 'mediamtx', exp: 9e9, mediamtx_permissions: [{ action: 'read', path: '' }] }))
    .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  throws(() => verifyJwt(pub, `${h}.${forged}.${s}`), 'подпись');
});
t('алгоритм none не принимается', () => {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  throws(() => verifyJwt(pub, `${h}.e30.`), 'алгоритм');
});
t('мусор вместо токена отклоняется', () => throws(() => verifyJwt(pub, 'abc'), 'повреждён'));

t('имя пути не содержит дефисов UUID', () => eq(pathFor(CAM), 'cam_11111111aaaa4aaa8aaa111111111111'));
t('адрес бриджа короче лимита ffmpeg в 128 символов на логин-пароль', () => {
  const u = new URL(internalReadUrl('rtsp://127.0.0.1:8554', CAM, SECRET));
  yes(`${u.username}:${u.password}`.length < 128);
});

console.log('');
t('зритель со своим токеном — пропуск', () => yes(authorize(req({ token: viewerToken(priv, CAM) }), ctx).allow));
t('токен в ?jwt= тоже принимается', () => yes(authorize(req({ query: `jwt=${viewerToken(priv, CAM)}` }), ctx).allow));
t('токен одной камеры не открывает другую', () => yes(!authorize(req({ path: pathFor(OTHER), token: viewerToken(priv, CAM) }), ctx).allow));
t('зритель без токена — отказ', () => yes(!authorize(req(), ctx).allow));
t('без ключа проверки — отказ всем зрителям', () => yes(!authorize(req({ token: viewerToken(priv, CAM) }), { bridgeSecret: SECRET }).allow));

t('бридж с этой машины по секрету — пропуск', () => {
  yes(authorize(req({ ip: '127.0.0.1', protocol: 'rtsp', user: 'bridge', password: SECRET }), ctx).allow);
});
t('бридж с чужого адреса — отказ, даже с секретом', () => {
  yes(!authorize(req({ protocol: 'rtsp', user: 'bridge', password: SECRET }), ctx).allow);
});
t('RTSP с токеном зрителя — отказ', () => {
  yes(!authorize(req({ ip: '127.0.0.1', protocol: 'rtsp', user: 'x', password: viewerToken(priv, CAM) }), ctx).allow);
});
t('пустой секрет бриджа никого не пускает', () => {
  yes(!authorize(req({ ip: '127.0.0.1', protocol: 'rtsp', user: 'bridge', password: '' }), { key: pub, bridgeSecret: '' }).allow);
});

t('публикация запрещена всегда', () => {
  yes(!authorize(req({ ip: '127.0.0.1', action: 'publish', protocol: 'rtsp', user: 'bridge', password: SECRET }), ctx).allow);
});
t('API только с этой машины', () => {
  yes(authorize(req({ ip: '127.0.0.1', action: 'api' }), ctx).allow, 'локально должно пускать');
  yes(!authorize(req({ action: 'api' }), ctx).allow, 'снаружи должно закрывать');
});
t('неизвестное действие — отказ', () => yes(!authorize(req({ action: 'playback' }), ctx).allow));

console.log('');
t('синхронизация: камера без адреса не заводится', () => {
  const d = new MediaSync({ apiBase: 'http://x' }).desired([{ id: CAM, ip_address: '' }, { id: OTHER, ip_address: '1.2.3.4' }], () => 'rtsp://1.2.3.4/x');
  eq([...d.keys()], [pathFor(OTHER)]);
});
t('синхронизация: поток тянется только по запросу и по TCP', () => {
  const d = new MediaSync({ apiBase: 'http://x' }).desired([{ id: CAM, ip_address: '1.2.3.4' }], () => 'rtsp://1.2.3.4/x');
  const c = d.get(pathFor(CAM));
  eq([c.sourceOnDemand, c.rtspTransport], [true, 'tcp']);
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}\n`);
process.exit(failed ? 1 : 0);
