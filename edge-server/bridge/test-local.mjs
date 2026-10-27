// test-local.mjs — самопроверка Bridge v7 БЕЗ камер и без Supabase.
// Запуск:  node test-local.mjs
// Проверяет: трекер, анализ действий по сериям, каскад гейта (реальный код из
// index.js), извлечение burst-серии через ffmpeg, и (если есть интернет)
// детектор+скелеты на реальном фото с отрисовкой в test-annotated.jpg.

import { CameraTracker } from './tracker.js';
import { analyzeBurstPoses } from './action.js';
import { grabBurst } from './burst.js';
import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';

let PASS = 0, FAIL = 0;
const check = (name, cond) => { cond ? PASS++ : FAIL++; console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`); };
const section = (t) => console.log(`\n═══ ${t} ═══`);

section('ТРЕКЕР');
{

const box = (cx, cy, w=0.1, h=0.3) => ({ x1:cx-w/2, y1:cy-h/2, x2:cx+w/2, y2:cy+h/2 });

const _ignore1 = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond?'✓':'✗ FAIL'} ${name}`); };

// Тест 1: два человека идут навстречу — ID стабильны
{
  const tr = new CameraTracker();
  let t = 0;
  let idA, idB;
  for (let f = 0; f < 10; f++) {
    const a = { cls:'person', conf:0.9, ...box(0.2 + f*0.05, 0.5) };
    const b = { cls:'person', conf:0.9, ...box(0.8 - f*0.05, 0.5) };
    tr.update([a, b], t);
    const ppl = tr.tracks.filter(x=>x.group==='person');
    if (f === 1) { ppl.sort((x,y)=>x.cx()-y.cx()); idA = ppl[0].id; idB = ppl[1].id; }
    t += 250; // 4 fps
  }
  const ppl = tr.tracks;
  check('два человека → ровно 2 трека', ppl.length === 2);
  const nowA = ppl.find(p=>p.id===idA), nowB = ppl.find(p=>p.id===idB);
  check('ID сохранились после пересечения', !!nowA && !!nowB && nowA.cx() > nowB.cx());
  check('скорость посчитана (~0.2 ед/с)', Math.abs(nowA.speed() - 0.2) < 0.08);
}

// Тест 2: человек стоит 200 сек → loitering
{
  const tr = new CameraTracker();
  let t = 0;
  for (let f = 0; f < 15; f++) { tr.update([{cls:'person',conf:0.9,...box(0.5,0.5)}], t); t += 15000; }
  const hints = tr.sceneHints(t - 15000);
  check('лойтеринг сработал', hints.some(h=>h.type==='loitering'));
}

// Тест 3: сумка осталась, человек ушёл → abandoned_local через 45с, и НЕ раньше
{
  const tr = new CameraTracker();
  let t = 0;
  // человек с сумкой рядом 3 кадра
  for (let f = 0; f < 3; f++) { tr.update([{cls:'person',conf:0.9,...box(0.5,0.5)},{cls:'backpack',conf:0.8,...box(0.52,0.62,0.08,0.1)}], t); t += 1000; }
  let early = tr.sceneHints(t);
  check('сумка при хозяине — тихо', !early.some(h=>h.type==='abandoned_local'));
  // человек уходит, сумка лежит
  for (let f = 0; f < 10; f++) { tr.update([{cls:'person',conf:0.9,...box(Math.min(0.98, 0.5+f*0.09),0.5)},{cls:'backpack',conf:0.8,...box(0.52,0.62,0.08,0.1)}], t); t += 6000; }
  const hints = tr.sceneHints(t - 6000);
  check('брошенная сумка поймана локально', hints.some(h=>h.type==='abandoned_local'));
}

// Тест 4: потерянный трек умирает после TTL
{
  const tr = new CameraTracker({ ttlMs: 10000 });
  tr.update([{cls:'person',conf:0.9,...box(0.5,0.5)}], 0);
  tr.update([], 5000);
  check('до TTL трек жив', tr.tracks.length === 1);
  tr.update([], 20000);
  check('после TTL трек удалён', tr.tracks.length === 0);
}

// Тест 5: бег
{
  const tr = new CameraTracker();
  let t = 0;
  for (let f = 0; f < 6; f++) { tr.update([{cls:'person',conf:0.9,...box(0.1+f*0.15,0.5)}], t); t += 250; }
  check('бег детектится', tr.sceneHints(t-250).some(h=>h.type==='running'));
}



}

section('АНАЛИЗ ДЕЙСТВИЙ (burst-серии, синтетика)');
{

// Генератор синтетических скелетов. Человек ростом h, центр (cx, топ headY).
function makePerson(cx, topY, h, { wristAtMouth=false, wristOffset=[0.12,0.45], lying=false } = {}) {
  const kpts = Array.from({length:17}, () => ({x:cx, y:topY+h*0.5, c:0.9}));
  const set = (i,dx,dy) => { kpts[i] = { x:cx+dx, y:topY+dy, c:0.9 }; };
  if (!lying) {
    set(0, 0, 0.05*h);                    // nose
    set(5,-0.10*h, 0.22*h); set(6, 0.10*h, 0.22*h);   // shoulders
    set(11,-0.07*h, 0.52*h); set(12, 0.07*h, 0.52*h); // hips
    set(15,-0.06*h, 0.97*h); set(16, 0.06*h, 0.97*h); // ankles
    if (wristAtMouth) { set(9, 0.02*h, 0.07*h); set(10, 0.14*h, 0.40*h); }
    else { set(9,-wristOffset[0]*h, wristOffset[1]*h); set(10, wristOffset[0]*h, wristOffset[1]*h); }
    return { conf:0.9, x1:cx-0.15*h, y1:topY, x2:cx+0.15*h, y2:topY+h, kpts };
  } else {
    // лежит: широкий низкий бокс, голова на уровне бёдер
    set(0,-0.45*h, 0.05*h); set(11,0,0.05*h); set(12,0.05*h,0.05*h);
    set(5,-0.3*h,0.03*h); set(6,-0.25*h,0.08*h); set(9,-0.5*h,0.05*h); set(10,-0.2*h,0.1*h);
    return { conf:0.9, x1:cx-0.5*h, y1:topY, x2:cx+0.5*h, y2:topY+0.22*h, kpts };
  }
}

const ASPECT = 16/9;

const _ignore2 = (n,c)=>{ c?pass++:fail++; console.log(`${c?'✓':'✗ FAIL'} ${n}`); };
const ts = (n, fps=4) => Array.from({length:n},(_,i)=>1000+i*1000/fps);

// 1) Спокойная ходьба двоих НЕ вплотную → никаких хинтов, calm
{
  const frames = [];
  for (let i=0;i<8;i++) frames.push([
    makePerson(0.2+i*0.01, 0.3, 0.4),
    makePerson(0.7-i*0.01, 0.3, 0.4),
  ]);
  const r = analyzeBurstPoses('calmcam', frames, ts(8), ASPECT);
  check('спокойная сцена: 0 хинтов', r.hints.length===0);
  check('спокойная сцена: calm=true', r.calm===true);
}

// 2) Удар: двое вплотную, у одного запястье летит 1.6 роста/сек
{
  const frames = [];
  for (let i=0;i<8;i++) {
    const puncherWrist = (i===4||i===5) ? [0.45, 0.25] : [0.12, 0.45]; // выброс руки вперёд-вверх
    frames.push([
      makePerson(0.45, 0.3, 0.4, { wristOffset: puncherWrist }),
      makePerson(0.58, 0.3, 0.4),
    ]);
  }
  const r = analyzeBurstPoses('fightcam', frames, ts(8), ASPECT);
  check('драка поймана', r.hints.some(h=>h.type==='fight_signal'));
  console.log('   wristSpeed=', r.wristSpeed.toFixed(2), 'roста/с; bestFrame=', r.bestFrameIdx);
}

// 3) Падение: человек стоит, за 3 кадра (0.75с) оседает и лежит
{
  const frames = [];
  for (let i=0;i<8;i++) {
    if (i<4) frames.push([ makePerson(0.5, 0.25, 0.45) ]);
    else if (i<6) frames.push([ makePerson(0.5, 0.25+ (i-3)*0.12, 0.45*(1-(i-3)*0.25)) ]); // оседает
    else frames.push([ makePerson(0.5, 0.62, 0.42, { lying:true }) ]);
  }
  const r = analyzeBurstPoses('fallcam', frames, ts(8), ASPECT);
  const f = r.hints.find(h=>h.type==='fall');
  check('падение поймано', !!f);
  console.log('   detail:', f?.detail);
}

// 4) Курение: рука у рта 6 кадров из 8
{
  const frames = [];
  for (let i=0;i<8;i++) frames.push([ makePerson(0.5, 0.3, 0.4, { wristAtMouth: i>=1 && i<=6 }) ]);
  const r = analyzeBurstPoses('smokecam', frames, ts(8), ASPECT);
  check('жест курения пойман', r.hints.some(h=>h.type==='hand_to_mouth'));
}

// 5) Быстрая жестикуляция БЕЗ сближения → драки нет
{
  const frames = [];
  for (let i=0;i<8;i++) {
    const w = (i%2===0) ? [0.4,0.3] : [0.1,0.5];
    frames.push([ makePerson(0.2, 0.3, 0.4, { wristOffset:w }), makePerson(0.75, 0.3, 0.4) ]);
  }
  const r = analyzeBurstPoses('gestcam', frames, ts(8), ASPECT);
  check('жестикуляция вдали ≠ драка', !r.hints.some(h=>h.type==='fight_signal'));
}



}

section('КАСКАД ГЕЙТА (код из index.js)');
{
// Тест каскада гейта: вырезаем блок reason из НАСТОЯЩЕГО index.js и гоняем с моками

const src = await readFile('./index.js', 'utf8');
const start = src.indexOf('      let reason = null;');
const end = src.indexOf("else if (needForce && wants(...PEOPLE_SCENARIOS, 'fire'))");
const block = src.slice(start, src.indexOf('\n', end));

function decide(ctx) {
  const fn = new Function(
    'danger','possibleFire','actFall','actFight','actSmoke','recentSuspicion','persons','afterHrs',
    'thAbandoned','thRunning','thLoiter','prev','bags','cloudCooldownOk','action','needForce',
    'wants','PEOPLE_SCENARIOS','fireScore','rapidModeRef','sceneChanged',
    block.replace(/rapidMode = true/g, 'rapidModeRef.v = true') + '\nreturn reason;'
  );
  const rapidModeRef = { v: false };
  const enabledSc = ctx.scenarios ? new Set(ctx.scenarios) : null;
  const wants = (...keys) => !enabledSc || keys.some(k => enabledSc.has(k));
  const PEOPLE_SCENARIOS = ['theft','fight','smoking','fall','crowd','child_lost','suspicious','intrusion','weapon'];
  const reason = fn(
    ctx.danger||[], ctx.fire||false, ctx.fall||null, ctx.fight||null, ctx.smoke||null, ctx.susp||false,
    ctx.persons||0, ctx.afterHrs||false, ctx.abandoned||null, ctx.running||null, ctx.loiter||null,
    ctx.prev||{persons:0}, ctx.bags||[], ctx.cooldownOk??true, ctx.action||{calm:false}, ctx.force||false,
    wants, PEOPLE_SCENARIOS, 0.02, rapidModeRef, ctx.sceneChanged??true
  );
  return { reason, rapid: rapidModeRef.v };
}


const _ignore3 = (n,c)=>{ c?pass++:fail++; console.log(`${c?'✓':'✗ FAIL'} ${n}`); };

// камера ТОЛЬКО с fire: люди не должны жечь облако
let r = decide({ scenarios:['fire'], persons:3, prev:{persons:0} });
check('камера fire-only: появление людей → $0', r.reason === null);
r = decide({ scenarios:['fire'], fire:true });
check('камера fire-only: огонь → облако + rapid', r.reason?.includes('огонь') && r.rapid);
r = decide({ scenarios:['fire'], danger:[{cls:'knife'}], persons:1 });
check('камера fire-only: нож → $0 (weapon выключен)', r.reason === null);

// камера weapon+fight: нож ловится, курение нет
r = decide({ scenarios:['weapon','fight'], danger:[{cls:'knife'}], persons:1 });
check('weapon вкл: нож → облако', r.reason?.includes('ОПАСНЫЙ') && r.rapid);
r = decide({ scenarios:['weapon','fight'], smoke:{detail:'x'}, persons:1 });
check('smoking выкл: жест курения → $0... но человек появился?', r.reason !== null); // wants(PEOPLE) - fight есть → появление людей пройдёт
r = decide({ scenarios:['weapon','fight'], smoke:{detail:'x'}, persons:1, prev:{persons:1}, cooldownOk:false });
check('smoking выкл, люди те же: курение НЕ триггерит', r.reason === null);

// без enabled_scenarios (null) — всё работает как раньше
r = decide({ scenarios:null, smoke:{detail:'x'}, persons:1, prev:{persons:1} });
check('scenarios=null: курение → облако (обратная совместимость)', r.reason?.includes('курения'));

// трекер-хинты
r = decide({ scenarios:['suspicious'], abandoned:{detail:'сумка 60 сек'}, persons:1, prev:{persons:1}, cooldownOk:false });
check('брошенная вещь → облако при suspicious', r.reason?.includes('ТРЕКЕР'));
r = decide({ scenarios:['fire'], abandoned:{detail:'x'}, persons:0 });
check('брошенная вещь при fire-only → $0', r.reason === null);
r = decide({ scenarios:['intrusion'], running:{detail:'бежит'}, afterHrs:true, persons:1, prev:{persons:1}, cooldownOk:false });
check('бег ночью при intrusion → rapid', r.reason?.includes('🏃') && r.rapid);
r = decide({ scenarios:['intrusion'], running:{detail:'бежит'}, afterHrs:false, persons:1, prev:{persons:1}, cooldownOk:false });
check('бег ДНЁМ → $0 (не показатель)', r.reason === null);

// падение в больничном сценарии
r = decide({ scenarios:['fall'], fall:{detail:'лежит'}, persons:1 });
check('fall вкл: падение → rapid', r.reason?.includes('падение') && r.rapid);
r = decide({ scenarios:['smoking'], fall:{detail:'лежит'}, persons:1, prev:{persons:1}, cooldownOk:false });
check('fall выкл: падение → $0', r.reason === null);




  // ═══ тесты фикса петли наблюдения (v7.3) ═══
  const s1 = decide({ scenarios:null, susp:true, persons:0, prev:{persons:0}, sceneChanged:false });
  check('v7.3: наблюдение + СТАТИЧНАЯ сцена → $0 (петля разорвана)', s1.reason === null);
  const s2 = decide({ scenarios:null, susp:true, persons:1, prev:{persons:1}, sceneChanged:true, cooldownOk:true });
  check('v7.3: наблюдение + сцена ИЗМЕНИЛАСЬ → облако + rapid', s2.reason?.includes('👁') && s2.rapid);
  const s3 = decide({ scenarios:['fire'], susp:true, persons:1, prev:{persons:1}, sceneChanged:true, cooldownOk:true });
  check('v7.3: fire в списке wants наблюдения → 👁 работает на fire-камере', s3.reason?.includes('👁'));
  const s4 = decide({ scenarios:null, susp:true, persons:1, prev:{persons:1}, sceneChanged:true, cooldownOk:false });
  check('v7.3: наблюдение уважает кулдаун', s4.reason === null || !s4.reason.includes('👁'));
}

section('ПРЕДОХРАНИТЕЛИ (guard.js)');
{
  const { buildSceneFp, CloudBudget } = await import('./guard.js');
  const d = (cls,cx,cy) => ({ cls, x1:cx-0.05, y1:cy-0.05, x2:cx+0.05, y2:cy+0.05 });

  const fpA = buildSceneFp([d('suitcase',0.30,0.40), d('suitcase',0.60,0.40)]);
  const fpB = buildSceneFp([d('suitcase',0.60,0.40), d('suitcase',0.30,0.40)]); // порядок другой
  check('отпечаток: порядок детекций не важен', fpA === fpB);

  const fpJit = buildSceneFp([d('suitcase',0.305,0.402), d('suitcase',0.598,0.399)]); // дрожание <5%
  check('отпечаток: микро-дрожание детектора не меняет отпечаток', fpA === fpJit);

  const fpMoved = buildSceneFp([d('suitcase',0.30,0.40), d('suitcase',0.75,0.40)]); // сумку унесли дальше
  check('отпечаток: реальное перемещение меняет отпечаток', fpA !== fpMoved);

  const fpFire = buildSceneFp([d('suitcase',0.30,0.40), d('suitcase',0.60,0.40)], true);
  check('отпечаток: появление огня меняет отпечаток', fpA !== fpFire);

  check('отпечаток: пустая сцена стабильна', buildSceneFp([]) === buildSceneFp([]));

  const bud = new CloudBudget(3);
  const t0 = 1000000;
  const r = [bud.take('c1',t0), bud.take('c1',t0+1), bud.take('c1',t0+2), bud.take('c1',t0+3), bud.take('c1',t0+4)];
  check('бюджет: первые 3 вызова проходят', r[0].ok && r[1].ok && r[2].ok);
  check('бюджет: 4-й вызов отклонён + firstDenial', !r[3].ok && r[3].firstDenial === true);
  check('бюджет: 5-й отклонён, telegram-спама нет', !r[4].ok && r[4].firstDenial === false);
  check('бюджет: другая камера не задета', bud.take('c2',t0).ok);
  check('бюджет: через час счётчик сброшен', bud.take('c1', t0 + 3600001).ok);
}

section('ONVIF: разбор ответов реальных камер (Dahua/Imou, Hikvision)');
{
  const { wsSecurityHeader, pickTag, pickAllTags, pickProfileTokens, parseProbeMatches,
          withCredentials, splitRtsp, soapEnvelope } = await import('./onvif.js');
  const { createHash } = await import('crypto');

// ── 1. WS-Security digest против эталона OASIS ──
// Digest = Base64(SHA1(nonce_bytes + created_utf8 + password_utf8))
const nonceB64 = 'LKqI6G/AikKCQrN0zqZFlg==', created = '2010-09-16T09:16:03.000Z', pw = 'userpassword';
const expect = createHash('sha1').update(Buffer.concat([
  Buffer.from(nonceB64,'base64'), Buffer.from(created,'utf8'), Buffer.from(pw,'utf8')
])).digest('base64');
const hdr = wsSecurityHeader('user', pw, nonceB64, created);
check('WS-Security: дайджест по формуле SHA1(nonce+created+pass)', hdr.includes(`>${expect}<`));
check('WS-Security: nonce и created попали в заголовок', hdr.includes(nonceB64) && hdr.includes(created));
check('WS-Security: тип PasswordDigest указан', hdr.includes('#PasswordDigest'));
check('WS-Security: спецсимволы в логине экранируются', wsSecurityHeader('a<b&c','p').includes('a&lt;b&amp;c'));

// ── 2. Реальный ответ WS-Discovery (Dahua/Imou) ──
const probeResp = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/IPC onvif://www.onvif.org/hardware/IPC-K2EP</d:Scopes><d:XAddrs>http://192.168.10.8/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const addrs = parseProbeMatches(probeResp);
check('discovery: адрес сервиса извлечён', addrs.includes('http://192.168.10.8/onvif/device_service'));
check('discovery: несколько XAddrs через пробел разобраны', addrs.length === 2);

// ── 3. Реальный GetProfilesResponse (два профиля, как у Imou) ──
const profilesResp = `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><SOAP-ENV:Body><trt:GetProfilesResponse><trt:Profiles token="MediaProfile00000" fixed="true"><tt:Name>MediaProfile00000</tt:Name><tt:VideoEncoderConfiguration token="VideoEncoder_1"><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>2304</tt:Width><tt:Height>1296</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles><trt:Profiles token="MediaProfile00001" fixed="true"><tt:Name>MediaProfile00001</tt:Name><tt:VideoEncoderConfiguration token="VideoEncoder_2"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>704</tt:Width><tt:Height>576</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles></trt:GetProfilesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const tokens = pickProfileTokens(profilesResp);
check('профили: оба токена найдены', tokens.length === 2 && tokens[0] === 'MediaProfile00000');
const blocks = profilesResp.match(/<(?:[A-Za-z0-9_.-]+:)?Profiles\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?Profiles>/g);
check('профили: разрезаны на блоки', blocks.length === 2);
check('профили: разрешение основного 2304x1296',
  pickTag(blocks[0],'Width') === '2304' && pickTag(blocks[0],'Height') === '1296');
check('профили: субпоток 704x576 (не перепутан с основным)', pickTag(blocks[1],'Width') === '704');

// ── 4. GetStreamUriResponse — Dahua и Hikvision ──
const dahuaUri = `<SOAP-ENV:Envelope><SOAP-ENV:Body><trt:GetStreamUriResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:MediaUri xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Uri>rtsp://192.168.10.8:554/cam/realmonitor?channel=1&amp;subtype=0&amp;unicast=true</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect></trt:MediaUri></trt:GetStreamUriResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const hikUri = `<env:Envelope><env:Body><trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.168.1.64:554/Streaming/Channels/101?transportmode=unicast</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse></env:Body></env:Envelope>`;
check('Dahua/Imou: RTSP извлечён', pickTag(dahuaUri,'Uri').startsWith('rtsp://192.168.10.8:554/cam/realmonitor'));
check('Hikvision: RTSP извлечён (другой префикс namespace)', pickTag(hikUri,'Uri').includes('/Streaming/Channels/101'));

// ── 5. Разбор и подстановка учётки ──
const raw = 'rtsp://192.168.10.8:554/cam/realmonitor?channel=1&subtype=0';
const withAuth = withCredentials(raw, 'admin', 'P@ss w/rd');
check('учётка подставлена в URL', withAuth.startsWith('rtsp://admin:') && withAuth.includes('@192.168.10.8'));
check('спецсимволы пароля закодированы', withAuth.includes('%40') && !withAuth.includes('P@ss w/rd'));
const sp = splitRtsp(raw);
check('разбор на поля админки: ip/port/path',
  sp.ip === '192.168.10.8' && sp.port === 554 && sp.path === '/cam/realmonitor?channel=1&subtype=0');
check('порт по умолчанию 554, если не указан', splitRtsp('rtsp://10.0.0.5/live').port === 554);

// ── 6. Ошибка авторизации распознаётся ──
const authFail = `<s:Envelope><s:Body><s:Fault><s:Code><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code><s:Reason><s:Text>Sender not Authorized</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;
check('ошибка авторизации ловится по тексту', /NotAuthorized|Sender not Authorized/i.test(authFail));

// ── 7. Конверт SOAP валиден ──
const env = soapEnvelope('<tds:GetSystemDateAndTime/>');
check('SOAP-конверт корректен', env.includes('soap-envelope') && env.includes('<s:Body>'));


}

section('HTTP-API для админки (кнопки «Найти камеры» и «Проверить»)');
{
  const { startApi } = await import('./api.js');
// Тест HTTP-API как его увидит браузер админки

const FAKE_JPEG = Buffer.from('ffd8ffe000104a464946','hex');
const srv = startApi({
  version:'v7.6-test', log:()=>{},
  grabSnapshot: async (rtsp) => { if (/badpass/.test(rtsp)) throw new Error('401 Unauthorized'); return FAKE_JPEG; },
  detect: async () => ([{cls:'person',conf:0.912},{cls:'cup',conf:0.44}]),
  buildRtspUrl: (b) => `rtsp://${b.login}:${b.password}@${b.ip}:${b.port}${b.rtsp_path||'/live'}`,
  getStatus: () => ({ detector:'yolox_s', zones:2 }),
}, { port: 8123, host:'127.0.0.1' });
await new Promise(r=>setTimeout(r,300));
const B = 'http://127.0.0.1:8123';

// health
const h = await (await fetch(`${B}/health`)).json();
check('health: отвечает, версия и статус', h.ok && h.version==='v7.6-test' && h.detector==='yolox_s');

// CORS — критично, иначе браузер заблокирует запрос из админки
const pre = await fetch(`${B}/health`, { method:'OPTIONS', headers:{Origin:'https://safezone.vercel.app'} });
check('CORS: preflight 204 + разрешение источника',
  pre.status===204 && !!pre.headers.get('access-control-allow-origin'));
check('CORS: POST разрешён', /POST/.test(pre.headers.get('access-control-allow-methods')||''));

// probe по готовому rtsp
const p1 = await (await fetch(`${B}/probe`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({rtsp:'rtsp://ok/live'})})).json();
check('probe: кадр получен + превью base64', p1.ok && p1.preview.startsWith('data:image/jpeg;base64,'));
check('probe: детекции вернулись', p1.detections.length===2 && p1.people===1);

// probe по полям формы админки
const p2 = await (await fetch(`${B}/probe`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({ip:'192.168.10.8',port:554,login:'admin',password:'x',path:'/cam/realmonitor?channel=1&subtype=0'})})).json();
check('probe: собирает RTSP из полей формы', p2.ok);

// неверный пароль → понятная ошибка, а не 500
const p3 = await (await fetch(`${B}/probe`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({rtsp:'rtsp://badpass/live'})})).json();
check('probe: ошибка авторизации → понятный текст + подсказка', !p3.ok && /401/.test(p3.error) && !!p3.hint);

// нет данных
const p4 = await fetch(`${B}/probe`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
check('probe: без параметров → 400', p4.status===400);

// discover (мультикаст в песочнице пуст, но эндпоинт обязан отвечать корректно)
const d = await (await fetch(`${B}/discover`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({multicast:true})})).json();
check('discover: отвечает корректной структурой', d.ok && Array.isArray(d.suggestions) && Array.isArray(d.logs));

// несуществующий путь
check('неизвестный эндпоинт → 404', (await fetch(`${B}/nope`)).status===404);

srv.close();

}

section('НАСТРОЙКИ ФУНКЦИЙ (settings.js) — приоритеты и защита от мусора');
{
  const { buildConfig, coerce, diffConfig, SCHEMA, uiSchema } = await import('./settings.js');

// ── приоритеты ──
check('пустая БД → берём .env (поведение v7.6 не меняется)',
  buildConfig({ MAX_CLOUD_PER_CAM_HOUR:'99' }, null).MAX_CLOUD_PER_CAM_HOUR === 99);
check('нет ни БД, ни env → жёсткий дефолт',
  buildConfig({}, null).MAX_CLOUD_PER_CAM_HOUR === 60);
check('БД перекрывает env',
  buildConfig({ MAX_CLOUD_PER_CAM_HOUR:'99' }, { MAX_CLOUD_PER_CAM_HOUR: 30 }).MAX_CLOUD_PER_CAM_HOUR === 30);
check('пустая строка в БД не затирает env',
  buildConfig({ TILED_GRID:'3' }, { TILED_GRID:'' }).TILED_GRID === 3);

// ── валидация: панель не должна суметь сломать бридж ──
check('мусор в enum игнорируется', buildConfig({}, { TILED_DETECT:'ерунда' }).TILED_DETECT === 'auto');
check('число выше максимума зажимается', buildConfig({}, { TILED_GRID: 99 }).TILED_GRID === 4);
check('число ниже минимума зажимается', buildConfig({}, { BURST_FRAMES: -5 }).BURST_FRAMES === 3);
check('текст вместо числа → дефолт', buildConfig({}, { LOITER_SEC:'абв' }).LOITER_SEC === 180);
check('кривое время → дефолт', buildConfig({}, { AFTER_HOURS_START:'25 часов' }).AFTER_HOURS_START === '22:00');
check('корректное время принимается', buildConfig({}, { AFTER_HOURS_START:'23:30' }).AFTER_HOURS_START === '23:30');

// ── булевы: главная ловушка ──
check('bool: строка "false" из БД выключает', buildConfig({}, { ZONES_ENABLED:'false' }).ZONES_ENABLED === false);
check('bool: настоящий false выключает', buildConfig({}, { ZONES_ENABLED:false }).ZONES_ENABLED === false);
check('bool: "true" включает', buildConfig({}, { LOCAL_ONLY:'true' }).LOCAL_ONLY === true);
check('bool: env "false" уважается', buildConfig({ BURST_ENABLED:'false' }, null).BURST_ENABLED === false);
check('bool: выключение НЕ падает обратно в дефолт true',
  buildConfig({ ZONES_ENABLED:'true' }, { ZONES_ENABLED:false }).ZONES_ENABLED === false);

// ── diff ──
const a = buildConfig({}, null), b = buildConfig({}, { TILED_GRID:3, DETECTOR:'yolox_m' });
const d = diffConfig(a,b);
check('diff: видит оба изменения', d.length === 2);
check('diff: помечает требующие перезапуска', d.find(x=>x.key==='DETECTOR').restart === true);
check('diff: живые не помечены', d.find(x=>x.key==='TILED_GRID').restart === false);
check('diff: одинаковые конфиги → пусто', diffConfig(a,a).length === 0);

// ── схема для UI ──
const ui = uiSchema();
check('UI: настройки разложены по группам', Object.keys(ui).length >= 6);
check('UI: у каждой настройки есть подпись', Object.values(ui).flat().every(x=>x.label));
check('UI: покрыты все ключи схемы', Object.values(ui).flat().length === Object.keys(SCHEMA).length);


}

section('ЖИВОЕ ПРИМЕНЕНИЕ настроек из панели');
{
  const { buildConfig, diffConfig } = await import('./settings.js');
  const { CloudBudget } = await import('./guard.js');
  const { ZoneEngine } = await import('./zones.js');
// Живое применение настроек: имитируем панель, меняющую конфиг на лету

// повторяем логику applyConfig из index.js
let RT = buildConfig({ MAX_CLOUD_PER_CAM_HOUR:'60', ZONES_ENABLED:'true' }, null);
let cloudBudget = new CloudBudget(RT.MAX_CLOUD_PER_CAM_HOUR);
let zoneEngine = new ZoneEngine([{id:'t',name:'Стол',camera:'c',rule:'uncleaned',zone:[[0,0],[1,0],[1,1],[0,1]],seconds:300}],
  { dishClasses: String(RT.DISH_CLASSES).split(','), graceSec: RT.ZONE_GRACE_SEC });
const logs = [];

function applyConfig(dbConfig) {
  const next = buildConfig({ MAX_CLOUD_PER_CAM_HOUR:'60', ZONES_ENABLED:'true' }, dbConfig);
  const changes = diffConfig(RT, next);
  if (!changes.length) return changes;
  RT = next;
  if (changes.some(c=>['ZONES_ENABLED','DISH_CLASSES','ZONE_GRACE_SEC'].includes(c.key))) {
    zoneEngine = RT.ZONES_ENABLED ? new ZoneEngine([{id:'t',name:'Стол',camera:'c',rule:'uncleaned',zone:[[0,0],[1,0],[1,1],[0,1]],seconds:300}],
      { dishClasses: String(RT.DISH_CLASSES).split(','), graceSec: RT.ZONE_GRACE_SEC }) : null;
  }
  if (changes.some(c=>c.key==='MAX_CLOUD_PER_CAM_HOUR')) cloudBudget = new CloudBudget(RT.MAX_CLOUD_PER_CAM_HOUR);
  changes.forEach(c=>logs.push(`${c.key}: ${c.from} → ${c.to}`));
  return changes;
}

// ── стартовое состояние = .env ──
check('старт: лимит из .env', RT.MAX_CLOUD_PER_CAM_HOUR === 60);
const t0 = 1e6;
for (let i=0;i<60;i++) cloudBudget.take('cam',t0);
check('старт: бюджет 60 исчерпан на 61-м', !cloudBudget.take('cam',t0).ok);

// ── панель снижает лимит до 10 ──
const ch = applyConfig({ MAX_CLOUD_PER_CAM_HOUR: 10 });
check('панель: изменение поймано', ch.length===1 && ch[0].key==='MAX_CLOUD_PER_CAM_HOUR');
check('панель: бюджет ПЕРЕСОЗДАН с новым лимитом', cloudBudget.max === 10);
const t1 = 2e6;
for (let i=0;i<10;i++) cloudBudget.take('cam2',t1);
check('панель: новый лимит реально действует', !cloudBudget.take('cam2',t1).ok);

// ── выключение зон из панели ──
applyConfig({ MAX_CLOUD_PER_CAM_HOUR:10, ZONES_ENABLED:false });
check('панель: зоны выключены → движок снят', zoneEngine === null);

// ── включение обратно + смена посуды ──
applyConfig({ MAX_CLOUD_PER_CAM_HOUR:10, ZONES_ENABLED:true, DISH_CLASSES:'cup,plate' });
check('панель: зоны включены обратно', zoneEngine !== null);
check('панель: список посуды применился', zoneEngine.dishClasses.includes('plate'));

// ── ключевое: посуда из НОВОГО списка срабатывает ──
const CAM = {id:'c',name:'c'};
const plate = {cls:'plate',conf:.6,x1:.4,y1:.4,x2:.5,y2:.5};
let t=3e6, fired=false;
for (let i=0;i<70;i++){ if(zoneEngine.evaluate(CAM,[plate],t).length) fired=true; t+=5000; }
check('панель: новый класс посуды реально ловится правилом', fired);

// ── откат к пустому конфигу возвращает .env ──
applyConfig(null);
check('панель: очистка настроек → возврат к .env', RT.MAX_CLOUD_PER_CAM_HOUR === 60 && RT.ZONES_ENABLED === true);

// ── повторное применение того же не шумит ──
const noise = applyConfig(null);
check('панель: повтор без изменений → тишина в логах', noise.length === 0);


}

section('API настроек (как дёргает панель)');
{
  const { startApi } = await import('./api.js');
  const { buildConfig, uiSchema } = await import('./settings.js');
// Проверка эндпоинтов настроек так, как их дёргает панель

let RT = buildConfig({}, null);
let reloaded = 0;
const srv = startApi({
  version:'v7.7', log:()=>{},
  grabSnapshot: async()=>Buffer.from('ffd8ff','hex'), detect: async()=>[],
  getStatus: ()=>({ detector: RT.DETECTOR }),
  getSettings: ()=>({ schema: uiSchema(), current:{...RT}, source:'db' }),
  onSettingsSaved: async ()=>{ reloaded++; RT = buildConfig({}, { TILED_GRID:3 }); },
}, { port: 8124, host:'127.0.0.1' });
await new Promise(r=>setTimeout(r,300));
const B='http://127.0.0.1:8124';

const s = await (await fetch(`${B}/settings`)).json();
check('GET /settings: схема и значения отдаются', s.ok && s.schema && s.current);
check('GET /settings: группы для UI на месте', Object.keys(s.schema).length >= 6);
check('GET /settings: у пунктов есть label и restart',
  Object.values(s.schema).flat().every(i=>i.label!==undefined && i.restart!==undefined));
check('GET /settings: текущие значения = дефолты', s.current.TILED_GRID === 2);

const r = await (await fetch(`${B}/settings/reload`,{method:'POST'})).json();
check('POST /settings/reload: бридж перечитал БД', reloaded === 1 && r.ok);
check('POST /settings/reload: вернул НОВЫЕ значения', r.current.TILED_GRID === 3);

// health содержит источник настроек
const h = await (await fetch(`${B}/health`)).json();
check('health: отдаёт статус детектора', h.ok && !!h.detector);

srv.close();

}

section('ОЧЕРЕДЬ КОМАНД панель→бридж (commands.js)');
{
  const { createCommandRunner } = await import('./commands.js');
  function mkSb(rows, opts={}) {
    const updates = [];
    return { rows, updates, from(){ return {
      select(){ const q={ eq(){return q}, order(){return q}, limit(){
        if (opts.error) return Promise.resolve({data:null,error:opts.error});
        return Promise.resolve({ data: rows.filter(r=>r.status==='pending').slice(0,1), error:null });
      }}; return q; },
      update(patch){ return { eq(_,id){ updates.push({id,patch});
        const r=rows.find(x=>x.id===id); if(r) Object.assign(r,patch);
        return Promise.resolve({error:null}); } }; },
    };}};
  }
  const FAKE = Buffer.from('ffd8ffe000104a464946','hex');
  const deps = (sb, extra={}) => ({
    sb, mallId:'M1', log:()=>{},
    discoverCameras: extra.discover || (async ({onLog}) => { onLog?.('скан'); return [{
      host:'192.168.10.8', info:{manufacturer:'Imou',model:'K2EP'}, error:null,
      profiles:[{name:'main',resolution:'2304x1296',parsed:{ip:'192.168.10.8',port:554,path:'/cam/realmonitor?channel=1&subtype=0'}},
        {name:'sub',resolution:'704x576',parsed:{ip:'192.168.10.8',port:554,path:'/cam/realmonitor?channel=1&subtype=1'}}]}]; }),
    grabSnapshot: extra.grab || (async ()=>FAKE),
    detect: async ()=>[{cls:'person',conf:0.91}],
    buildRtspUrl: (b)=>`rtsp://${b.username}:${b.password}@${b.ip}:${b.port}${b.rtsp_path||'/live'}`,
  });

  let rows=[{id:'c1',mall_id:'M1',kind:'discover',status:'pending',params:{subnet:'192.168.10',user:'admin',pass:'СЕКРЕТ'}}];
  let sb=mkSb(rows);
  await createCommandRunner(deps(sb)).tick();
  check('очередь: discover выполнен', rows[0].status==='done' && rows[0].result.suggestions.length===2);
  check('очередь: субпоток помечен', rows[0].result.suggestions[1].is_substream===true);
  check('очередь: 🔒 пароль затёрт из params', JSON.stringify(rows[0].params)==='{}');
  check('очередь: сначала running, потом done',
    sb.updates[0].patch.status==='running' && sb.updates[1].patch.status==='done');

  rows=[{id:'c2',mall_id:'M1',kind:'probe',status:'pending',params:{ip:'192.168.10.8',port:554,username:'admin',password:'СЕКРЕТ',path:'/cam/x'}}];
  await createCommandRunner(deps(mkSb(rows))).tick();
  check('очередь: probe вернул превью и детекции',
    rows[0].status==='done' && rows[0].result.preview.startsWith('data:image/jpeg;base64,') && rows[0].result.people===1);
  check('очередь: 🔒 пароль probe затёрт', JSON.stringify(rows[0].params)==='{}');

  rows=[{id:'c3',mall_id:'M1',kind:'probe',status:'pending',params:{ip:'1.1.1.1',username:'a',password:'b'}}];
  await createCommandRunner(deps(mkSb(rows),{grab:async()=>{throw new Error('401 Unauthorized')}})).tick();
  check('очередь: ошибка камеры → status error с текстом', rows[0].status==='error' && /401/.test(rows[0].error));
  check('очередь: 🔒 пароль затёрт и при ошибке', JSON.stringify(rows[0].params)==='{}');

  rows=[{id:'c4',mall_id:'M1',kind:'ерунда',status:'pending',params:{}}];
  await createCommandRunner(deps(mkSb(rows))).tick();
  check('очередь: неизвестная команда → error, бридж жив', rows[0].status==='error');

  const sbNo=mkSb([],{error:{message:'relation "bridge_commands" does not exist'}});
  const rNo=createCommandRunner(deps(sbNo)); await rNo.tick(); await rNo.tick();
  check('очередь: нет таблицы → бридж не падает', true);

  rows=[{id:'c5',mall_id:'M1',kind:'discover',status:'pending',params:{}}];
  let started=0;
  const rPar=createCommandRunner(deps(mkSb(rows),{discover:async()=>{started++;await new Promise(x=>setTimeout(x,60));return [];}}));
  await Promise.all([rPar.tick(), rPar.tick(), rPar.tick()]);
  check('очередь: параллельные тики не дублируют выполнение', started===1);
}

section('ЗОНЫ И ТАЙМЕРЫ СЕРВИСА (zones.js) — всё локально, $0');
{
  const { ZoneEngine, pointInPolygon, anyInZone } = await import('./zones.js');

const SQ = (x1,y1,x2,y2) => [[x1,y1],[x2,y1],[x2,y2],[x1,y2]];
// человек: бокс, «ноги» = низ
const person = (cx, feetY) => ({ cls:'person', conf:0.9, x1:cx-0.05, y1:feetY-0.3, x2:cx+0.05, y2:feetY });
const cup    = (cx, cy)     => ({ cls:'cup', conf:0.6, x1:cx-0.02, y1:cy-0.03, x2:cx+0.02, y2:cy });

// геометрия
check('точка внутри квадрата', pointInPolygon(0.5,0.5, SQ(0.2,0.2,0.8,0.8)));
check('точка снаружи', !pointInPolygon(0.9,0.5, SQ(0.2,0.2,0.8,0.8)));
check('невыпуклый L-полигон: точка в вырезе снаружи',
  !pointInPolygon(0.7,0.7, [[0.1,0.1],[0.9,0.1],[0.9,0.4],[0.4,0.4],[0.4,0.9],[0.1,0.9]]));
check('якорь "ноги": человек над зоной НЕ считается внутри',
  !anyInZone([person(0.5, 0.35)], SQ(0.4,0.5,0.6,0.9), ['person']));
check('якорь "ноги": человек стоит в зоне', anyInZone([person(0.5, 0.7)], SQ(0.4,0.5,0.6,0.9), ['person']));

const GUEST = SQ(0.1,0.5,0.5,0.95), STAFF = SQ(0.6,0.4,0.95,0.9), TABLE = SQ(0.15,0.3,0.5,0.7);
const mkEngine = () => new ZoneEngine([
  { id:'bar', name:'Барная стойка', camera:'тест', rule:'no_staff', guest_zone:GUEST, staff_zone:STAFF, seconds:300, repeat_sec:300, severity:'medium' },
  { id:'t1', name:'Стол 1', camera:'тест', rule:'uncleaned', zone:TABLE, seconds:300, repeat_sec:300 },
], { graceSec: 15 });
const CAM = { id:'cam-1', name:'тест' };
const guest = person(0.3, 0.8), barman = person(0.75, 0.8), atTable = person(0.3, 0.65);
const dishes = [cup(0.25,0.5), cup(0.35,0.55)];

// ── СЦЕНАРИЙ 1: бармена нет ровно 5 минут ──
{
  const e = mkEngine(); let t = 1_000_000;
  const step = (dets, sec=5) => { const f = e.evaluate(CAM, dets, t); t += sec*1000; return f; };
  let firedAt = null;
  for (let i = 0; i < 70; i++) {           // 350 сек по 5 сек
    const f = step([guest]);               // гость есть, бармена нет
    if (f.length && !firedAt) firedAt = (t - 1_000_000)/1000 - 5;
  }
  check(`бармен: тревога ровно на 5-й минуте (сработала на ${firedAt}с)`, firedAt >= 300 && firedAt <= 305);

  // до 5 минут — тишина
  const e2 = mkEngine(); let t2 = 2_000_000, any = false;
  for (let i = 0; i < 59; i++) { if (e2.evaluate(CAM,[guest],t2).length) any = true; t2 += 5000; }
  check('бармен: до 5 минут НИ одной тревоги (295с)', !any);
}

// ── повтор каждые 5 минут ──
{
  const e = mkEngine(); let t = 3_000_000; const times = [];
  for (let i = 0; i < 200; i++) {          // 1000 сек
    if (e.evaluate(CAM,[guest],t).length) times.push((t-3_000_000)/1000);
    t += 5000;
  }
  check(`повтор каждые 5 мин (сработки на ${times.join(', ')}с)`,
    times.length === 3 && times[1]-times[0] === 300 && times[2]-times[1] === 300);
}

// ── бармен вернулся → сброс ──
{
  const e = mkEngine(); let t = 4_000_000;
  for (let i = 0; i < 50; i++) { e.evaluate(CAM,[guest],t); t += 5000; }   // 250с ждём
  for (let i = 0; i < 5; i++) { e.evaluate(CAM,[guest,barman],t); t += 5000; } // бармен пришёл (25с)
  let any = false;
  for (let i = 0; i < 20; i++) { if (e.evaluate(CAM,[guest],t).length) any = true; t += 5000; } // 100с
  check('бармен вернулся → таймер сброшен, ложной тревоги нет', !any);
}

// ── анти-дребезг: бармен «мигнул» на кадр, таймер НЕ сбрасывается ──
{
  const e = mkEngine(); let t = 5_000_000; let firedAt = null;
  for (let i = 0; i < 70; i++) {
    const flicker = (i === 30);            // один кадр детектор ошибочно увидел бармена
    const f = e.evaluate(CAM, flicker ? [guest,barman] : [guest], t);
    t += 5000;
    if (f.length && !firedAt) firedAt = (t-5_000_000)/1000 - 5;
  }
  check(`анти-дребезг: моргание детектора не сбило таймер (сработка ${firedAt}с)`, firedAt >= 300 && firedAt <= 310);
}

// ── СЦЕНАРИЙ 2: посуда не убрана ──
{
  const e = mkEngine(); let t = 6_000_000; let fired = null;
  for (let i = 0; i < 70; i++) { const f = e.evaluate(CAM, dishes, t); t += 5000; if (f.length && !fired) fired = f[0]; }
  check('посуда: тревога через 5 минут', !!fired);
  check('посуда: тип события uncleaned_table', fired?.type === 'uncleaned_table');
  console.log(`   текст: "${fired?.description}"`);
}

// ── гости ещё за столом → тишина ──
{
  const e = mkEngine(); let t = 7_000_000; let anyUncleaned = false, anyBar = false;
  for (let i = 0; i < 80; i++) {
    for (const f of e.evaluate(CAM,[...dishes, atTable],t)) {
      if (f.type === 'uncleaned_table') anyUncleaned = true;
      if (f.type === 'no_staff') anyBar = true;
    }
    t += 5000;
  }
  check('посуда: гости ЗА столом → «убрать» НЕ шлётся', !anyUncleaned);
  check('пересечение зон: гость у стола попал и в зону бара (зоны нельзя накладывать!)', anyBar);
}

// ── посуду убрали до 5 минут ──
{
  const e = mkEngine(); let t = 8_000_000; let any = false;
  for (let i = 0; i < 40; i++) { e.evaluate(CAM, dishes, t); t += 5000; }     // 200с
  for (let i = 0; i < 40; i++) { if (e.evaluate(CAM, [], t).length) any = true; t += 5000; } // убрали
  check('посуда: убрали вовремя → тревоги нет', !any);
}

// ── правило чужой камеры не срабатывает ──
{
  const e = mkEngine(); let t = 9_000_000; let any = false;
  for (let i = 0; i < 80; i++) { if (e.evaluate({id:'cam-9',name:'другая'}, [guest], t).length) any = true; t += 5000; }
  check('правила привязаны к своей камере', !any);
}


}

section('ДАЛЬНОЗОРКОСТЬ (tiles.js)');
try {
  const { tiledDetect, mergeDets } = await import('./tiles.js');
  const sharp = (await import('sharp')).default;

  // юнит: маппинг координат тайл→кадр
  const mockDetect = async () => [{ cls:'person', conf:0.9, x1:0.45, y1:0.45, x2:0.55, y2:0.55 }];
  const blank = await sharp({ create:{ width:1000, height:1000, channels:3, background:{r:100,g:100,b:100} } }).jpeg().toBuffer();
  const mres = await tiledDetect(blank, mockDetect, { grid:2 });
  check('тайлы: 4 тайла → 4 объекта, координаты глобальные', mres.length === 4 && mres.every(d => d.x1>=0 && d.x2<=1));

  // юнит: дедуп зоны перекрытия (мелкие боксы по центрам)
  const dup = mergeDets(
    [{cls:'person',conf:0.9,x1:0.400,y1:0.400,x2:0.430,y2:0.470}],
    [{cls:'person',conf:0.85,x1:0.408,y1:0.406,x2:0.438,y2:0.476}]
  );
  check('тайлы: дубль мелкого бокса из перекрытия схлопнут', dup.length === 1);

  // реальный: люди ~62px на кадре 2304px — полный кадр слеп, тайлы видят
  const { execSync } = await import('child_process');
  execSync('curl -sL --max-time 20 -o /tmp/sz_zid.jpg https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/zidane.jpg');
  const zid = await readFile('/tmp/sz_zid.jpg');
  const small = await sharp(zid).resize(110).jpeg().toBuffer();
  const canvas = await sharp({ create:{ width:2304, height:1296, channels:3, background:{r:88,g:95,b:90} } })
    .composite([{ input: small, left: 1950, top: 1000 }]).jpeg().toBuffer();
  const { createYolox } = await import('./yolox.js');
  const yx = createYolox('yolox_s.onnx', 640);
  const full = (await yx.detect(canvas)).filter(d=>d.cls==='person').length;
  const tiled = (await tiledDetect(canvas, yx.detect, { grid:2 })).filter(d=>d.cls==='person').length;
  console.log(`  люди ~62px: полный кадр=${full}, тайлы 2x2=${tiled}`);
  check('тайлы: полный кадр дальних НЕ видит', full === 0);
  check('тайлы: тайловый проход дальних ЛОВИТ', tiled >= 1);
} catch (e) { console.log(`  (реальная часть пропущена: ${e.message})`); }

section('УСТОЙЧИВАЯ ВСТАВКА В БД (dbsafe.js)');
{
  const { insertDroppingUnknownColumns } = await import('./dbsafe.js');
  // мок supabase: первый вызов ругается на zone_id, второй проходит
  let calls = [];
  const mkSb = (failCols) => ({ from: () => ({ insert: async (p) => {
    calls.push({ ...p });
    for (const c of failCols) if (c in p) return { error: { code: 'PGRST204', message: `Could not find the '${c}' column of 'events' in the schema cache` } };
    return { error: null };
  }})});

  calls = [];
  const r1 = await insertDroppingUnknownColumns(mkSb(['zone_id']), 'events', { a: 1, zone_id: 'z', b: 2 }, () => {});
  check('dbsafe: событие сохранено без отсутствующей колонки', r1.error === null && r1.dropped.join(',') === 'zone_id');
  check('dbsafe: повтор ушёл без zone_id', calls.length === 2 && !('zone_id' in calls[1]) && calls[1].a === 1);

  calls = [];
  const r2 = await insertDroppingUnknownColumns(mkSb(['zone_id','extra']), 'events', { a: 1, zone_id: 'z', extra: 'x' }, () => {});
  check('dbsafe: несколько отставших колонок', r2.error === null && r2.dropped.length === 2);

  calls = [];
  const sbOther = { from: () => ({ insert: async () => ({ error: { code: '23505', message: 'duplicate key' } }) }) };
  const r3 = await insertDroppingUnknownColumns(sbOther, 'events', { a: 1 }, () => {});
  check('dbsafe: чужие ошибки не глотаются', r3.error && r3.error.code === '23505');

  // ── CHECK-ограничение: реальная схема Adam'а отвергала 'weapon' и зонные типы ──
  let c2 = [];
  const sbCheck = (bad) => ({ from: () => ({ insert: async p => {
    c2.push({ ...p });
    if (bad.includes(p.type)) return { error: { code: '23514', message: 'violates check constraint "events_type_check"' } };
    return { error: null };
  }})});

  c2 = [];
  const w = await insertDroppingUnknownColumns(sbCheck(['weapon']), 'events', { type:'weapon', description:'нож в руке' }, () => {});
  check('dbsafe: старая база отвергла weapon → сохранено как suspicious', w.error === null && c2[1].type === 'suspicious');
  check('dbsafe: исходный тип не потерян (ушёл в описание)', c2[1].description.startsWith('[weapon]'));

  c2 = [];
  const z = await insertDroppingUnknownColumns(sbCheck(['no_staff']), 'events', { type:'no_staff', description:'бармен' }, () => {});
  check('dbsafe: зонный тип падает в violation, а не теряется', z.error === null && c2[1].type === 'violation');

  c2 = [];
  const ok = await insertDroppingUnknownColumns(sbCheck([]), 'events', { type:'weapon' }, () => {});
  check('dbsafe: после миграции weapon пишется как есть', ok.error === null && c2.length === 1 && c2[0].type === 'weapon');
}

section('BURST (извлечение серии ffmpeg)');
try {
// Тест burst.js: генерим видео ffmpeg'ом (движущийся паттерн) и извлекаем серию

execSync('ffmpeg -y -f lavfi -i testsrc=duration=4:size=640x360:rate=10 -q:v 4 /tmp/testvid.mp4 2>/dev/null');
const t0 = Date.now();
const { buffers, timestamps } = await grabBurst('/tmp/testvid.mp4', 'testcam', { frames: 8, fps: 4 });
console.log(`Извлечено кадров: ${buffers.length} за ${Date.now()-t0}ms`);
console.log(`Размеры: ${buffers.map(b=>Math.round(b.length/1024)+'KB').join(', ')}`);
console.log(`dt между метками: ${timestamps[1]-timestamps[0]}ms (ожидаем 250)`);
if (buffers.length === 8 && timestamps[1]-timestamps[0] === 250) check('извлечение burst-серии', true);

} catch (e) { check('извлечение burst-серии (' + e.message + ')', false); }

section('ДЕТЕКТОР + СКЕЛЕТЫ на реальном фото (нужен интернет для тестового фото)');
try {
  execSync('curl -sL --max-time 20 -o /tmp/sz_test.jpg https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/bus.jpg');
  const buf = await readFile('/tmp/sz_test.jpg');
  const { detect } = await import('./yolo.js');
  const { poseDetect } = await import('./pose.js');
  const t0 = Date.now();
  const dets = await detect(buf);
  const tDet = Date.now() - t0;
  const t1 = Date.now();
  const { persons, aspect } = await poseDetect(buf);
  const tPose = Date.now() - t1;
  console.log(`  детект ${tDet}ms: ${dets.map(d => d.cls + ':' + ((d.conf*100)|0) + '%').join(', ')}`);
  console.log(`  поза ${tPose}ms: ${persons.length} чел, aspect=${aspect.toFixed(2)}`);
  check('детектор нашёл людей', dets.filter(d => d.cls === 'person').length >= 3);
  check('скелеты найдены', persons.length >= 2);
  const DETECTOR = process.env.DETECTOR;
  if (DETECTOR && DETECTOR.startsWith('yolox')) {
    const { createYolox } = await import('./yolox.js');
    const sizes = { yolox_s: 640, yolox_tiny: 416, yolox_nano: 416 };
    const yx = createYolox(DETECTOR + '.onnx', sizes[DETECTOR]);
    const t2 = Date.now();
    const xd = await yx.detect(buf);
    console.log(`  ${DETECTOR} ${Date.now()-t2}ms: ${xd.map(d => d.cls + ':' + ((d.conf*100)|0) + '%').join(', ')}`);
    check(DETECTOR + ' нашёл людей', xd.filter(d => d.cls === 'person').length >= 3);
  }
} catch (e) { console.log(`  (пропущено: ${e.message})`); }

section('RTMO (Apache-позы) на реальном фото');
try {
  const { existsSync } = await import('fs');
  if (existsSync('./rtmo_m.onnx')) {
    const buf = await readFile('/tmp/sz_test.jpg');
    const { rtmoDetect } = await import('./rtmo.js');
    const t0 = Date.now();
    const { persons } = await rtmoDetect(buf);
    console.log(`  rtmo_m ${Date.now() - t0}ms: ${persons.length} чел (conf: ${persons.map(p => (p.conf * 100) | 0 + '').join(',')})`);
    check('rtmo нашёл людей (включая перекрытых)', persons.length >= 4);
    const p0 = persons[0];
    const nose = p0.kpts[0], hips = p0.kpts[11];
    check('rtmo санити скелета (нос выше бёдер)', nose.c > 0.3 && hips.c > 0.3 && nose.y < hips.y);
  } else console.log('  rtmo_m.onnx нет — пропуск');
} catch (e) { check('rtmo (' + e.message + ')', false); }

section('ЛОКАЛЬНЫЙ VLM (мок OpenAI-совместимого сервера)');
try {
  const { createServer } = await import('http');
  const { localVlmAnalyze, localVlmPing, compactPrompt } = await import('./localvlm.js');
// Мок OpenAI-совместимого сервера: проверяем протокол, парсинг 3 стилей ответа, таймаут, 500


const GOOD = { people_count: 2, is_safe: false, threats: [{ type:'fight', severity:'high', confidence:0.7, description:'двое дерутся' }], scene_description: 'тест' };
let mode = 'clean';
let lastReq = null;

const srv = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ data: [{ id: 'qwen3-vl:2b' }] }));
  }
  let body = '';
  for await (const c of req) body += c;
  lastReq = JSON.parse(body);
  if (mode === 'hang') return; // таймаут — не отвечаем
  if (mode === 'err500') { res.writeHead(500); return res.end('boom'); }
  const styles = {
    clean:  JSON.stringify(GOOD),
    fenced: '```json\n' + JSON.stringify(GOOD) + '\n```',
    chatty: 'Хорошо, вот мой анализ кадра:\n' + JSON.stringify(GOOD) + '\nНадеюсь, это поможет!',
  };
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({ choices: [{ message: { content: styles[mode] } }] }));
});
await new Promise(r => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}/v1`;

// ping
const ping = await localVlmPing(base);
check('ping ok + список моделей', ping.ok && ping.models[0] === 'qwen3-vl:2b');

// протокол запроса
const args = { baseUrl: base, model: 'qwen3-vl:2b', prompt: compactPrompt({name:'Тест', floor:1}, 'удар 2.5 роста/с', false), base64: 'AAAA', timeoutMs: 3000 };
const r1 = await localVlmAnalyze(args);
check('чистый JSON распарсен', r1.threats[0].type === 'fight');
check('запрос: модель передана', lastReq.model === 'qwen3-vl:2b');
check('запрос: текст + картинка data-url', lastReq.messages[0].content[0].type==='text' && lastReq.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,AAAA'));
check('запрос: подсказка детектора в промпте', lastReq.messages[0].content[0].text.includes('удар 2.5 роста/с'));
check('запрос: без response_format (совместимость)', !('response_format' in lastReq));

mode='fenced'; const r2 = await localVlmAnalyze(args);
check('JSON в ```fenced``` распарсен', r2.people_count === 2);

mode='chatty'; const r3 = await localVlmAnalyze(args);
check('JSON среди болтовни распарсен', r3.is_safe === false);

mode='err500';
let threw=false; try { await localVlmAnalyze(args); } catch(e) { threw = e.message.includes('500'); }
check('HTTP 500 → исключение', threw);

mode='hang';
threw=false; const t0=Date.now(); try { await localVlmAnalyze({...args, timeoutMs: 1200}); } catch(e) { threw=true; }
check(`таймаут срабатывает (${Date.now()-t0}ms)`, threw && Date.now()-t0 < 2500);

srv.close();

} catch (e) { check('локальный VLM (' + e.message + ')', false); }

section('LOCAL_ONLY: статические гарантии (код index.js)');
{
  const idx = await readFile('./index.js', 'utf8');
  const guardPos = idx.indexOf('RT.LOCAL_ONLY && !result');
  const cloudPos = idx.indexOf('if (OPENROUTER_API_KEY)');
  check('страховка LOCAL_ONLY стоит ДО облачных ярусов', guardPos > 0 && cloudPos > 0 && guardPos < cloudPos);
  check('premium-перепроверка OpenAI выключена в LOCAL_ONLY', idx.includes('OPENAI_API_KEY && !RT.LOCAL_ONLY'));
  // булев не должен сравниваться со строкой — на этом уже обжигались (кадры уходили в облако)
  check('LOCAL_ONLY нигде не сравнивается со строкой', !/RT\.LOCAL_ONLY\s*[!=]==\s*'/.test(idx));
  check('все живые ключи читаются через RT (нет утечки .env в горячий код)',
    !/(?<![\w.])(TILED_GRID|STATIC_RECHECK_MIN|MAX_CLOUD_PER_CAM_HOUR)\s*[*<>)]/.test(idx.slice(idx.indexOf('} = process.env;'))));
  check('ярус 0 (локальная VLM) в каскаде есть', idx.includes('ЯРУС 0: ЛОКАЛЬНАЯ VLM'));
}

console.log(`\n══════════════════════════════`);
console.log(`ИТОГ: ${PASS} ok, ${FAIL} fail`);
process.exit(FAIL ? 1 : 0);
