import sharp from 'sharp';
import { DrawerWatch, drawerEvidence, judgeDrawer, handAtBody, DRAWER_TEXT } from './drawerwatch.js';
import { W, H } from './shelfchange.js';

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };
const section = s => console.log(`\n=== ${s} ===\n`);

const DRAWER = { id: 'd', kind: 'cash_drawer', name: 'Касса 1', points: [[0.40, 0.55], [0.56, 0.55], [0.56, 0.80], [0.40, 0.80]] };
const CUSTOMER = { id: 'c', kind: 'cash_customer', points: [[0.65, 0.05], [0.98, 0.05], [0.98, 0.98], [0.65, 0.98]] };

function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// пол в ромбик; открытый ящик — лоток с ячейками купюр; arm — полоса руки поверх
function scene({ open = false, gain = 1, bias = 0, noise = 0, seed = 1, arm = null, shadow = false } = {}) {
  const g = new Uint8Array(W * H), r = rnd(seed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = ((x >> 4) + (y >> 4)) % 2 ? 190 : 60;
    const nx = x / W, ny = y / H;
    if (open && nx > 0.40 && nx < 0.56 && ny > 0.55 && ny < 0.80) v = (y % 22 < 3 || x % 38 < 3) ? 25 : 110 + ((x >> 2) % 7) * 12;
    if (arm) {
      const dx = arm.x2 - arm.x1, dy = arm.y2 - arm.y1;
      const t = Math.max(0, Math.min(1, ((nx - arm.x1) * dx + (ny - arm.y1) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(nx - arm.x1 - t * dx, (ny - arm.y1 - t * dy) * H / W) < 0.018) v = 150;
    }
    if (shadow && nx > 0.3 && nx < 0.7) v *= 0.6;
    v = v * gain + bias + (noise ? (r() - 0.5) * 2 * noise : 0);
    g[y * W + x] = Math.max(0, Math.min(255, v));
  }
  return g;
}

function kp(over = {}) {
  const k = Array.from({ length: 17 }, () => ({ x: 0.30, y: 0.40, c: 0.9 }));
  k[5] = { x: 0.26, y: 0.45, c: 0.9 }; k[6] = { x: 0.34, y: 0.45, c: 0.9 };
  k[7] = { x: 0.25, y: 0.55, c: 0.9 }; k[8] = { x: 0.35, y: 0.55, c: 0.9 };
  k[9] = { x: 0.24, y: 0.66, c: 0.9 }; k[10] = { x: 0.36, y: 0.66, c: 0.9 };
  k[11] = { x: 0.27, y: 0.68, c: 0.9 }; k[12] = { x: 0.33, y: 0.68, c: 0.9 };
  for (const [i, v] of Object.entries(over)) k[i] = { c: 0.9, ...v };
  return k;
}
const AWAY = { x: 0.20, y: 0.30 };
const cashier = (rw = AWAY, id = 1) => ({ id, group: 'person', box: { x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.95 }, kpts: kp({ 8: { x: (0.34 + rw.x) / 2, y: (0.45 + rw.y) / 2 }, 10: rw }) });
const customer = () => ({ id: 9, group: 'person', box: { x1: 0.75, y1: 0.2, x2: 0.9, y2: 0.9 }, kpts: null });
const IN = { x: 0.48, y: 0.66 }, BODY = { x: 0.30, y: 0.52 }, GIVE = { x: 0.70, y: 0.5 };

const rep = (n, f) => Array.from({ length: n }, (_, i) => (typeof f === 'function' ? f(i) : f));
const CLOSED = scene(), OPEN = scene({ open: true });
const seed = rep(8, { gray: CLOSED, people: [] });

function run(frames, { regions = [DRAWER, CUSTOMER], opts = {}, step = 200, t0 = 0, prep = null } = {}) {
  const w = new DrawerWatch({ regions, ...opts });
  if (prep) prep(w);
  const events = [], alerts = []; let t = t0;
  for (const f of frames) {
    t += f.dt ?? step;
    if (f.sale != null) w.noteSale(t + f.sale);
    const r = w.step(f.gray, f.people || [], t);
    events.push(...r.events); alerts.push(...r.alerts);
  }
  return { w, events, alerts, kinds: alerts.map(a => a.kind), ev: events.map(e => e.kind) };
}
const withCust = g => ({ gray: g, people: [cashier(), customer()] });

section('Ящик открыт или закрыт — по виду зоны');
{
  let r = run([...seed, ...rep(10, withCust(OPEN)), ...rep(10, withCust(CLOSED))]);
  ok(r.ev.join() === 'open,close', 'открыли и закрыли — два события');
  ok(Math.abs(r.events[1].openMs - 2000) <= 400, 'длительность открытия посчитана');
  ok(r.w.log.length === 1, 'открытие записано в журнал');
  r = run([...seed, ...rep(2, withCust(OPEN)), ...rep(10, withCust(CLOSED))]);
  ok(r.ev.length === 0, 'мелькнувшее на два кадра изменение — не открытие');
  r = run([...rep(3, { gray: CLOSED, people: [] }), ...rep(10, withCust(OPEN))]);
  ok(r.ev.length === 0, 'без эталона «закрыт» модуль молчит');
  r = run(rep(10, withCust(OPEN)), { prep: w => w.calibrate(CLOSED) });
  ok(r.ev.join() === 'open', 'эталон можно задать вручную');
}

section('Что не считается открытием');
{
  const arm = { x1: 0.36, y1: 0.50, x2: 0.50, y2: 0.70 };
  const reach = { gray: scene({ arm }), people: [cashier({ x: 0.50, y: 0.70 }), customer()] };
  ok(run([...seed, ...rep(15, reach)]).ev.length === 0, 'рука лежит поверх закрытого ящика');
  ok(run([...seed, ...rep(15, withCust(scene({ gain: 0.7 })))]).ev.length === 0, 'свет стал темнее на 30 %');
  ok(run([...seed, ...rep(15, withCust(scene({ gain: 1.2, bias: 10 })))]).ev.length === 0, 'свет стал ярче');
  ok(run([...seed, ...rep(15, withCust(scene({ shadow: true })))]).ev.length === 0, 'тень на кассе');
  ok(run([...seed, ...rep(30, i => withCust(scene({ noise: 12, seed: i + 5 })))]).ev.length === 0, 'шум камеры');
  const r = run([...seed, ...rep(8, withCust(OPEN)), ...rep(30, i => withCust(scene({ open: true, noise: 12, seed: i + 5 })))]);
  ok(r.ev.join() === 'open', 'открытый ящик при шуме не «мигает»');
  const cover = { gray: scene({ open: true, arm }), people: [cashier({ x: 0.50, y: 0.70 }), customer()] };
  ok(run([...seed, ...rep(8, withCust(OPEN)), ...rep(15, cover)]).ev.join() === 'open', 'рука над открытым ящиком его не «закрывает»');
}

section('Открыт без покупателя');
{
  const alone = { gray: OPEN, people: [cashier()] };
  let r = run([...seed, ...rep(25, { gray: CLOSED, people: [cashier()] }), ...rep(20, alone)]);
  ok(r.kinds.join() === 'open_no_customer', 'покупателя нет — одна тревога');
  ok(r.alerts[0].drawer.name === 'Касса 1' && r.alerts[0].openMs >= 2000, 'в тревоге касса и длительность');
  ok(run([...seed, ...rep(30, withCust(OPEN))]).kinds.length === 0, 'покупатель у кассы — тревоги нет');
  ok(run([...seed, ...rep(5, withCust(CLOSED)), ...rep(15, alone)]).kinds.length === 0, 'покупатель только что отошёл — тревоги нет');
  ok(run([...seed, ...rep(25, { gray: CLOSED, people: [cashier()] }), ...rep(20, alone)], { regions: [DRAWER] }).kinds.length === 0, 'зона покупателя не размечена — правило молчит');
  ok(run([...seed, ...rep(25, { gray: CLOSED, people: [cashier()] }), ...rep(8, alone)], { opts: { aloneMs: 5000 } }).kinds.length === 0, 'короткое открытие без покупателя не тревожит');
  r = run([...seed, ...rep(25, { gray: CLOSED, people: [cashier()] }), ...rep(20, alone), ...rep(5, { gray: CLOSED, people: [cashier()] }), ...rep(20, alone)]);
  ok(r.kinds.length === 1 && r.ev.join() === 'open,close,open', 'повтор в течение двух минут — одна тревога');
  const night = Date.UTC(2026, 10, 19, 17, 30);
  r = run([...seed, ...rep(25, { gray: CLOSED, people: [cashier()] }), ...rep(20, alone)], { t0: night, prep: w => w.setQuiet([{ from: '22:00', to: '23:00' }]) });
  ok(r.kinds.length === 0 && r.ev.join() === 'open', 'тихие часы (инкассация) — тревоги нет, открытие в журнале');
}

section('Открыт слишком долго и открыт без чека');
{
  let r = run([...seed, ...rep(60, { ...withCust(OPEN), dt: 1000 })]);
  ok(r.kinds.join() === 'open_long', 'открыт дольше 45 с — одна тревога');
  r = run([...seed, ...rep(10, withCust(OPEN)), ...rep(40, { ...withCust(CLOSED), dt: 1000 })]);
  ok(r.kinds.length === 0, 'чеки не подключены — правило «без чека» молчит');
  const feed = { ...withCust(CLOSED), sale: 0 };
  r = run([...seed, feed, ...rep(40, { ...withCust(CLOSED), dt: 1000 }), ...rep(10, withCust(OPEN)), ...rep(40, { ...withCust(CLOSED), dt: 1000 })]);
  ok(r.kinds.join() === 'open_no_sale', 'чеки идут, а к открытию чека нет — тревога, даже если ящик уже закрыли');
  r = run([...seed, feed, ...rep(40, { ...withCust(CLOSED), dt: 1000 }), ...rep(10, withCust(OPEN)), { ...withCust(CLOSED), sale: -1500 }, ...rep(40, { ...withCust(CLOSED), dt: 1000 })]);
  ok(r.kinds.length === 0, 'чек рядом по времени — тревоги нет');
  r = run([...seed, feed, ...rep(40, { ...withCust(CLOSED), dt: 1000 }), ...rep(10, withCust(OPEN)), ...rep(25, { ...withCust(CLOSED), dt: 1000 }), { ...withCust(CLOSED), sale: -24000 }, ...rep(10, { ...withCust(CLOSED), dt: 1000 })]);
  ok(r.kinds.length === 0, 'чек пришёл из кассы с опозданием — тревоги нет');
  r = run([...seed, feed, { ...withCust(CLOSED), dt: 3 * 3600000 }, ...rep(10, withCust(OPEN)), ...rep(40, { ...withCust(CLOSED), dt: 1000 })]);
  ok(r.kinds.length === 0, 'чеки перестали приходить (касса отвалилась) — правило молчит');
}

section('Рука из открытого ящика — куда ушла');
{
  const f = (g, rw, cust = true) => ({ gray: g, people: [cashier(rw), ...(cust ? [customer()] : [])] });
  let r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, IN)), ...rep(5, f(OPEN, BODY))]);
  ok(r.kinds.join() === 'to_body', 'из ящика к телу — тревога');
  ok(r.alerts[0].trackId === 1 && r.alerts[0].touchAt > 0, 'в тревоге человек и момент касания');
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, IN)), ...rep(3, f(OPEN, GIVE)), ...rep(5, f(OPEN, BODY))]);
  ok(r.kinds.length === 0, 'сначала протянул покупателю (сдача) — тревоги нет');
  r = run([...seed, ...rep(5, f(CLOSED, AWAY)), ...rep(3, f(CLOSED, IN)), ...rep(5, f(CLOSED, BODY))]);
  ok(r.kinds.length === 0, 'ящик закрыт — рука над ним и к телу не считается');
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, IN)), f(OPEN, BODY), ...rep(5, f(OPEN, AWAY))]);
  ok(r.kinds.length === 0, 'рука мелькнула у тела на один кадр — тревоги нет');
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, IN)), ...rep(25, f(OPEN, AWAY)), ...rep(5, f(OPEN, BODY))]);
  ok(r.kinds.length === 0, 'к телу позже чем через 3 с — не связываем с ящиком');
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(5, f(OPEN, BODY)), ...rep(3, f(OPEN, IN)), ...rep(5, f(OPEN, AWAY))]);
  ok(r.kinds.length === 0, 'от тела в ящик (кладёт деньги) — тревоги нет');
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, IN)), ...rep(5, f(OPEN, BODY)), ...rep(3, f(OPEN, IN)), ...rep(5, f(OPEN, BODY))]);
  ok(r.kinds.length === 1, 'повтор — одна тревога');
  const EDGE = { x: 0.385, y: 0.66 }, hipNear = c => { const p = cashier(EDGE); p.kpts[12] = { x: 0.39, y: 0.68, c: 0.9 }; return { gray: OPEN, people: [p, customer()] }; };
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, { x: 0.405, y: 0.66 })), ...rep(8, hipNear())]);
  ok(r.kinds.length === 0, 'рука лежит на краю ящика рядом с бедром — тревоги нет');
  r = run([...seed, ...rep(5, f(OPEN, AWAY)), ...rep(3, f(OPEN, GIVE)), ...rep(3, f(OPEN, IN)), ...rep(5, f(OPEN, BODY))]);
  ok(r.kinds.length === 0, 'взял деньги у покупателя, положил в ящик, опустил руку — тревоги нет');
  r = run([...seed, ...rep(5, f(OPEN, AWAY, false)), ...rep(3, f(OPEN, IN, false)), ...rep(5, f(OPEN, BODY, false))], { regions: [DRAWER] });
  ok(r.kinds.join() === 'to_body', 'работает и без размеченной зоны покупателя');
}

section('Эталон устарел');
{
  const r = run([...rep(8, { gray: OPEN, people: [] }), ...rep(10, { gray: CLOSED, people: [] }), ...rep(20, { gray: CLOSED, people: [], dt: 60000 }), ...rep(5, { gray: CLOSED, people: [] }), ...rep(8, { gray: OPEN, people: [] })]);
  ok(r.ev.join() === 'open,relearn,open', 'начали с открытого ящика — через 10 минут покоя эталон исправляется сам');
  const w = new DrawerWatch({ regions: [DRAWER] }); let t = 0;
  for (const fr of seed) w.step(fr.gray, [], t += 200);
  const ref = w.drawers[0].ref;
  w.setRegions([{ ...DRAWER, name: 'Касса А' }, CUSTOMER]);
  ok(w.drawers[0].ref === ref && w.drawers[0].name === 'Касса А', 'смена настроек не сбрасывает эталон той же зоны');
  w.setRegions([{ ...DRAWER, points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]] }]);
  ok(w.drawers[0].ref === null, 'зону перерисовали — эталон набирается заново');
}

section('Камера сверху: тело повёрнуто как угодно');
{
  // координаты взяты с настоящей записи: плечи по вертикали кадра, бёдра левее плеч
  const top = (lw) => { const k = Array.from({ length: 17 }, () => ({ x: 0.7, y: 0.6, c: 0.9 }));
    k[5] = { x: 0.763, y: 0.675, c: 1 }; k[6] = { x: 0.719, y: 0.510, c: 1 }; k[11] = { x: 0.710, y: 0.752, c: 0.9 }; k[12] = { x: 0.680, y: 0.648, c: 0.9 };
    k[9] = { ...lw, c: 1 }; k[10] = { x: 0.660, y: 0.592, c: 1 }; return k; };
  ok(handAtBody(top({ x: 0.718, y: 0.796 }), 9) === true, 'кисть у бедра — «у тела»');
  ok(handAtBody(top({ x: 0.647, y: 0.785 }), 9) === false, 'кисть в ящике — не «у тела»');
  ok(handAtBody(top({ x: 0.718, y: 0.796 }), 10) === false, 'вторая рука на прилавке — не «у тела»');
  const k = top({ x: 0.718, y: 0.796 }); k[5].c = 0.1;
  ok(handAtBody(k, 9) === false, 'плечи не видны — не гадаем');
}

section('Вердикт облака');
{
  const a = k => ({ kind: k });
  ok(judgeDrawer(a('to_body'), null).send === true, 'облако недоступно → тревога уходит с пометкой');
  ok(judgeDrawer(a('open_no_customer'), { drawer_open: false, confidence: 0.9 }).send === false, 'облако уверено, что ящик закрыт → снята');
  ok(judgeDrawer(a('open_no_customer'), { drawer_open: true, customer_present: true, confidence: 0.8 }).send === false, 'покупатель на месте → снята');
  ok(judgeDrawer(a('to_body'), { drawer_open: true, cash_to: 'покупателю', confidence: 0.8 }).send === false, 'деньги отданы покупателю → снята');
  ok(judgeDrawer(a('to_body'), { drawer_open: true, cash_to: 'в карман', confidence: 0.9, comment: 'купюры убраны в карман' }).note.includes('карман'), 'комментарий облака попадает в описание');
  ok(judgeDrawer(a('to_body'), { drawer_open: true, cash_in_hand: false, cash_to: 'не видно', confidence: 0.9 }).send === true, 'денег уже не видно — тревога остаётся');
  ok(judgeDrawer(a('to_body'), { drawer_open: false, confidence: 0.4 }).send === true, 'неуверенный ответ тревогу не снимает');
  ok(judgeDrawer(a('open_long'), { drawer_open: true, customer_present: true, confidence: 0.9 }).send === true, 'долго открыт — покупатель рядом не отменяет');
  ok(['open_no_customer', 'open_long', 'open_no_sale', 'to_body'].every(k => DRAWER_TEXT[k]), 'у каждой тревоги есть текст');
}

section('Настоящий JPEG и снимок-доказательство');
{
  const jpeg = g => sharp(Buffer.from(g), { raw: { width: W, height: H, channels: 1 } }).jpeg({ quality: 85 }).toBuffer();
  const a = await jpeg(CLOSED), b = await jpeg(OPEN);
  const w = new DrawerWatch({ regions: [DRAWER, CUSTOMER] }); let t = 0; const ev = [], al = [];
  const feed = async (j, p, n) => { for (let i = 0; i < n; i++) { const r = await w.observe(j, p, t += 200); ev.push(...r.events); al.push(...r.alerts); } };
  await feed(a, [], 8); await feed(a, [cashier()], 25); await feed(b, [cashier()], 15); await feed(a, [cashier()], 6);
  ok(ev.map(e => e.kind).join() === 'open,close', 'через сжатие JPEG открытие и закрытие находятся так же');
  ok(al.length === 1 && Buffer.isBuffer(al[0].openFrame), 'кадр момента открытия сохранён');
  const img = await drawerEvidence(al[0], a); const m = await sharp(img).metadata();
  ok(m.width === 1280 && m.height === 360, 'доказательство — две панели: открыли и сейчас');
  const one = await sharp(await drawerEvidence({ ...al[0], openFrame: null }, b)).metadata();
  ok(one.width === 640, 'без кадра открытия — одна панель');
  ok((await new DrawerWatch({ regions: [] }).observe(a, [], 1)).events.length === 0, 'касса не размечена — модуль ничего не делает');
}

console.log(`\nИтого: ${passed} прошло, ${failed} упало\n`);
process.exit(failed ? 1 : 0);
