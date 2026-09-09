import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import WebSocket from 'ws';
import 'dotenv/config';
import { detect as v8Detect, fireHint as yoloFireHint, init as v8Init } from './yolo.js';
import { createYolox } from './yolox.js';
import { poseDetect as v8Pose, poseInit as v8PoseInit } from './pose.js';
import { rtmoDetect, rtmoInit } from './rtmo.js';
import { analyzeActions, analyzeBurstPoses } from './action.js';
import { getTracker } from './tracker.js';
import { grabBurst } from './burst.js';
import { localVlmAnalyze, localVlmPing, compactPrompt } from './localvlm.js';
import { buildSceneFp, CloudBudget } from './guard.js';
import { insertDroppingUnknownColumns } from './dbsafe.js';
import { tiledDetect, mergeDets } from './tiles.js';
import { ZoneEngine } from './zones.js';
import { startApi } from './api.js';
import { createCommandRunner } from './commands.js';
import { discoverCameras } from './onvif.js';
import { buildConfig, diffConfig, SCHEMA, uiSchema } from './settings.js';
import { ensureSession, heartbeat, platformString, statePath } from './pairing.js';
import { ComplianceSchedule } from './compliance.js';
import { readFileSync, existsSync } from 'fs';

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket;
}

const BRIDGE_VERSION = 'v7.12';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, PAIRING_CODE,
  GROQ_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GEMINI_API_KEY2, GEMINI_API_KEY3,
  OPENROUTER_API_KEY, OPENROUTER_MODEL = 'google/gemma-4-31b-it',
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MALL_ID,
  AI_INTERVAL = '30', CONFIDENCE_THRESHOLD = '0.6', ALERT_COOLDOWN_SEC = '120',
  AFTER_HOURS_START = '22:00', AFTER_HOURS_END = '06:00',
  MOTION_THRESHOLD = '2.0', MOTION_ENABLED = 'true', YOLO_ENABLED = 'true',
  BURST_ENABLED = 'true', BURST_FRAMES = '8', BURST_FPS = '4',
  DETECTOR = 'yolox_s', POSE_MODEL = 'rtmo_m', LOCAL_TRACKER = 'true',
  LOITER_SEC = '180', ABANDONED_LOCAL_SEC = '45',
  LOCAL_VLM_URL = '', LOCAL_VLM_MODEL = 'qwen3-vl:2b',
  LOCAL_VLM_TIMEOUT_MS = '45000', LOCAL_ONLY = 'false',
  MAX_CLOUD_PER_CAM_HOUR = '60', STATIC_RECHECK_MIN = '15',
  GROQ_MODEL = 'qwen/qwen3.6-27b',
  TILED_DETECT = 'auto', TILED_GRID = '2', TILED_EVERY_N = '5',
  ZONES_ENABLED = 'true', ZONES_FILE = './zones.json',
  DISH_CLASSES = 'cup,bowl,wine glass,bottle', ZONE_GRACE_SEC = '15',
  API_ENABLED = 'true', API_PORT = '8099', API_HOST = '127.0.0.1',
} = process.env;

// ── ЖИВОЙ КОНФИГ: БД (панель) поверх .env поверх дефолтов ──
// Пока в БД пусто — значения ровно те же, что в .env. Поведение не меняется.
let RT = buildConfig(process.env, null);
let commandRunner = null;   // очередь команд из панели (ONVIF-поиск, проверка камеры)

// ── Зоны: правила на таймерах, считаются ЛОКАЛЬНО, без единого вызова облака ──
let zoneEngine = null;
let zoneRulesRaw = [];
let zoneRulesFromDb = null;   // правила из редактора зон в панели (таблица zone_rules)
const compliance = new ComplianceSchedule();   // пункты регламента видеоконтроля из панели
function rebuildZoneEngine() {
  if (!RT.ZONES_ENABLED) { zoneEngine = null; return; }
  try {
    if (zoneRulesFromDb) {
      zoneRulesRaw = zoneRulesFromDb.filter(r => r.enabled !== false);
    } else if (existsSync(ZONES_FILE)) {
      const cfg = JSON.parse(readFileSync(ZONES_FILE, 'utf8'));
      zoneRulesRaw = (cfg.rules || []).filter(r => r.enabled !== false);
    }
    zoneEngine = new ZoneEngine(zoneRulesRaw, {
      dishClasses: String(RT.DISH_CLASSES).split(',').map(s => s.trim()).filter(Boolean),
      graceSec: RT.ZONE_GRACE_SEC,
    });
  } catch (e) {
    console.log(`[zones] ошибка чтения ${ZONES_FILE}: ${e.message}`);
    zoneEngine = null;
  }
}
rebuildZoneEngine();

// Выбор детектора: yolov8n (текущий, AGPL) | yolox_s / yolox_nano (Apache-2.0)
const YOLOX_SIZES = { yolox_s: 640, yolox_tiny: 416, yolox_nano: 416, yolox_m: 640, yolox_l: 640 };
let yoloDetect = v8Detect, yoloInit = v8Init;
if (YOLOX_SIZES[RT.DETECTOR]) {
  const yx = createYolox(RT.DETECTOR + '.onnx', YOLOX_SIZES[RT.DETECTOR]);
  yoloDetect = yx.detect;
  yoloInit = yx.init;
}

// Позы: yolov8n-pose (быстрее, AGPL) | rtmo_m (точнее в толпе/перекрытиях, Apache-2.0)
let poseDetect = v8Pose, poseInit = v8PoseInit;
if (RT.POSE_MODEL === 'rtmo_m') {
  poseDetect = rtmoDetect;
  poseInit = rtmoInit;
}

const GEMINI_KEYS = [GEMINI_API_KEY, GEMINI_API_KEY2, GEMINI_API_KEY3].filter(Boolean);
let geminiKeyIdx = 0;
const nextGeminiKey = () => {
  if (GEMINI_KEYS.length === 0) return null;
  const k = GEMINI_KEYS[geminiKeyIdx % GEMINI_KEYS.length];
  geminiKeyIdx++;
  return k;
};

// Старая схема (service_key + MALL_ID в .env) продолжает работать как раньше —
// уже стоящие у клиентов бриджи не ломаются. Новая привязка её не требует.
const LEGACY_MODE = !!(SUPABASE_SERVICE_KEY && MALL_ID);

if (!SUPABASE_URL || (!SUPABASE_ANON_KEY && !SUPABASE_SERVICE_KEY)) {
  console.error('В .env нужен SUPABASE_URL и SUPABASE_ANON_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, LEGACY_MODE ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: true },
  realtime: { transport: WebSocket },
});

let mallId = MALL_ID || null;
let bridgeToken = null;
let tgToken = TELEGRAM_BOT_TOKEN || null;
let tgChat = TELEGRAM_CHAT_ID || null;

/** Применяет всё, что объект прислал в ответ на привязку или heartbeat. */
function applyBridgePayload(payload) {
  if (!payload) return;
  if (payload.mall_id) mallId = payload.mall_id;
  if (payload.telegram?.bot_token) {
    tgToken = payload.telegram.bot_token;
    tgChat = payload.telegram.chat_id || tgChat;
  }
  if (payload.settings && Object.keys(payload.settings).length) applyConfig(payload.settings);
  if (payload.zone_rules || payload.compliance) {
    if (payload.compliance) {
      const before = compliance.size;
      compliance.replace(payload.compliance);
      if (before !== compliance.size) log(`Регламент: ${compliance.summary()}`);
    }
    const drawn = Array.isArray(payload.zone_rules?.rules) ? payload.zone_rules.rules : [];
    // локальные пункты регламента (уборка столов, персонал в зоне) считает
    // тот же движок зон, что и нарисованные вручную правила — облако не нужно
    const rules = [...drawn, ...compliance.toZoneRules()];
    const changed = JSON.stringify(rules) !== JSON.stringify(zoneRulesFromDb);
    zoneRulesFromDb = rules;
    if (changed) {
      rebuildZoneEngine();
      log(`Зоны из панели: правил ${zoneEngine ? zoneEngine.rules.length : 0}`);
    }
  }
}

let settings = {
  ai_enabled: true,
  ai_interval_sec: parseInt(AI_INTERVAL),
  ai_confidence: parseFloat(CONFIDENCE_THRESHOLD),
  ai_cooldown_sec: parseInt(ALERT_COOLDOWN_SEC),
};

const lastAlerts = {};
const lonelyChild = {};
const abandonedObjects = {};
const LONELY_CHILD_THRESHOLD_SEC = 300;
const ABANDONED_OBJECT_SEC = 60;

let intervalRef = null;
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function isAfterHours() {
  const now = new Date();
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = RT.AFTER_HOURS_START.split(':').map(Number);
  const [eh, em] = RT.AFTER_HOURS_END.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin > endMin) return currentMin >= startMin || currentMin < endMin;
  return currentMin >= startMin && currentMin < endMin;
}

function grabSnapshot(rtspUrl, cameraId) {
  return new Promise((resolve, reject) => {
    const tmpFile = `/tmp/snap_${cameraId}_${Date.now()}.jpg`;
    const args = ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-frames:v', '1', '-q:v', '5', '-y', tmpFile];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', c => { stderr += c.toString(); });
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, 20000);
    ff.on('close', async (code) => {
      clearTimeout(timer);
      try {
        if (code === 0) {
          const buf = await readFile(tmpFile);
          await unlink(tmpFile).catch(() => {});
          resolve(buf);
        } else {
          await unlink(tmpFile).catch(() => {});
          reject(new Error(`exit ${code}: ${stderr.split('\n').slice(-3).join(' ').slice(-200)}`));
        }
      } catch (e) { reject(e); }
    });
    ff.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function buildRtspUrl(cam) {
  const { username, password, ip_address, port, rtsp_path } = cam;
  const auth = username ? encodeURIComponent(username) + ':' + encodeURIComponent(password || '') + '@' : '';
  const path = rtsp_path && rtsp_path.startsWith('/') ? rtsp_path : '/' + (rtsp_path || '');
  return 'rtsp://' + auth + ip_address + ':' + (port || 554) + path;
}

async function sendTelegramPhoto(buffer, caption) {
  if (!tgToken || !tgChat) return;
  try {
    const formData = new FormData();
    formData.append('chat_id', tgChat);
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    formData.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'screenshot.jpg');
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendPhoto`, {
      method: 'POST', body: formData,
    });
    if (res.ok) { log('Telegram photo sent'); return; }
    const errText = await res.text();
    log(`Telegram sendPhoto ${res.status}: ${errText.slice(0, 250)}`);
    await sendTelegramText(caption);
  } catch (e) {
    log(`Telegram error: ${e.message}`);
    await sendTelegramText(caption).catch(() => {});
  }
}

async function sendTelegramText(text) {
  if (!tgToken || !tgChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

async function analyzeFrame(jpegBuffer, cam, localHint = null, checks = []) {
  const base64 = jpegBuffer.toString('base64');
  const afterHours = isAfterHours();

  const prompt = `Ты — бдительный AI охранник SafeZone. Твоя задача — быстро находить опасные ситуации: оружие, огонь, драки, кражи, курение, падения. Безопасность людей превыше всего.

ГЛАВНЫЙ ПРИНЦИП: будь ВНИМАТЕЛЕН к опасным предметам и действиям. Если видишь нож, ножницы, зажигалку, огонь, замах, удар, сигарету — СООБЩАЙ. Лучше предупредить и перепроверить, чем пропустить реальную угрозу.

При этом НЕ путай обычные предметы с оружием: телефон (плоский светящийся экран) — это НЕ нож, плавная жестикуляция при разговоре — это НЕ драка. Но при ЛЮБОМ сомнении в сторону опасности (предмет похож на нож, движение похоже на замах) — лучше сообщи с умеренной confidence (0.5), система перепроверит.

═══════════════════════════════════════
🔥 ОГОНЬ И ЗАЖИГАЛКИ:
═══════════════════════════════════════
УГРОЗА fire если видишь (confidence 0.6+):
- Пламя любого размера (оранжевый/жёлтый/синий язык огня)
- ЗАЖИГАЛКУ в руке — небольшой предмет который держат вертикально, часто у лица/сигареты (ДАЖЕ без видимого пламени — сам факт зажигалки это угроза)
- Спички (коробок, зажжённую спичку)
- Дым, задымление, пар от огня
- Тлеющую/горящую сигарету, вейп, кальян
- Искры

Как отличить зажигалку от телефона:
- Зажигалка — МАЛЕНЬКАЯ (помещается в кулаке), держат вертикально, часто подносят к лицу/сигарете, может быть огонёк сверху
- Телефон — БОЛЬШОЙ плоский прямоугольник со светящимся экраном, держат горизонтально перед лицом для просмотра

❌ НЕ fire:
- Светящийся экран телефона/планшета/монитора (это экран, не огонь)
- Лампочки, фонарики, блики солнца, отражения
- Просто красный/оранжевый предмет (одежда, сумка) без пламени

═══════════════════════════════════════
🔪 ОПАСНЫЕ И ОСТРЫЕ ПРЕДМЕТЫ:
═══════════════════════════════════════
УГРОЗА weapon если видишь (confidence 0.6+):
- Нож любого вида (кухонный, складной, канцелярский) — ищи лезвие или характерную форму
- НОЖНИЦЫ — два соединённых лезвия, видны кольца для пальцев
- Отвёртку, шило, стамеску, острый инструмент
- Пистолет, винтовку, любое огнестрельное
- Биту, палку, трубу, арматуру (особенно занесённую)
- Топор, мачете, серп, крупный острый предмет
- Бритву, осколок стекла, заточку

Как отличить опасный предмет от безопасного:
- Нож/ножницы — видно МЕТАЛЛИЧЕСКОЕ лезвие, блеск, остриё, у ножниц — кольца
- Телефон — плоский, со светящимся экраном, БЕЗ лезвия
- Если человек держит предмет КАК оружие (в кулаке остриём вперёд, замахивается) — это угроза даже если предмет не разобрать чётко (confidence 0.5)

❌ НЕ оружие (защита от ложных):
- ТЕЛЕФОН (плоский прямоугольник со светящимся экраном, держат для просмотра/разговора)
- Зарядка, кабель, наушники, провод
- Пульт, кошелёк, карта, ключи, ручка, карандаш, маркер
- Бутылка, стакан, чашка, расчёска, очки
- Просто рука в кармане или жест

Главное: ищи МЕТАЛЛИЧЕСКИЙ БЛЕСК и ЛЕЗВИЕ для ножа/ножниц. Светящийся плоский экран = телефон, не оружие. Но если видишь явное лезвие/остриё/ножницы — это УГРОЗА, сообщай.

═══════════════════════════════════════
👊 ДРАКА И АГРЕССИЯ:
═══════════════════════════════════════
УГРОЗА fight если видишь (confidence 0.6+):
- Удар кулаком/ногой/локтем по человеку
- ЗАМАХ рукой/кулаком/предметом (рука отведена назад для удара по человеку)
- Толчок, захват за одежду/шею, борьбу, потасовку
- Двое+ людей в физической схватке или столкновении
- Агрессивную позу лицом к лицу: сжатые кулаки, напряжённое тело, резкое сближение
- Человек замахивается предметом НА другого
- Хватание, удержание, заламывание рук

Признаки которые ОТЛИЧАЮТ драку от разговора:
- Резкие быстрые движения рук в сторону другого человека (не плавная жестикуляция)
- Один человек в защитной позе (закрывается, отшатывается, руки вверх для защиты)
- Контакт тел/рук, не просто стояние рядом
- Кулаки сжаты, замах

❌ НЕ драка:
- Спокойный разговор, плавная жестикуляция при беседе
- Поднятая рука для приветствия/объяснения (плавно, не замах)
- Объятия, рукопожатие, похлопывание по плечу
- Просто стоят близко и общаются
- Дети спокойно играют

Если видишь РЕЗКОЕ движение руки К человеку, замах, или защитную позу у второго — это похоже на драку, сообщай fight с confidence 0.5+. Перепроверка подтвердит.

═══════════════════════════════════════
🚬 КУРЕНИЕ И ВЕЙП (важно — внимательно):
═══════════════════════════════════════
УГРОЗА smoking если видишь (confidence 0.5+):
- Сигарету во рту, в руке или подносимую ко рту
- Характерный ЖЕСТ курения: рука с предметом движется к губам, предмет у рта
- Вейп/электронную сигарету/под — небольшое прямоугольное или цилиндрическое устройство у рта
- ПАР или дым изо рта, облачко пара (явный признак вейпа/курения)
- Кальян, мундштук
- Тлеющий огонёк/красную точку сигареты
- Человек держит руку у рта и выдыхает пар/дым

ОБРАЩАЙ ОСОБОЕ ВНИМАНИЕ на жест "рука подносится к лицу/рту с небольшим предметом" — это частый признак курения или вейпа. Если видишь такой жест + что-то в руке у рта → сообщай smoking с confidence 0.5.

❌ НЕ курение:
- Человек ест/пьёт (еда, чашка, бутылка у рта — это не сигарета)
- Почёсывание лица, рука у щеки без предмета
- Телефон у уха (разговор)

═══════════════════════════════════════
💰 КРАЖА (только явное сокрытие):
═══════════════════════════════════════
УГРОЗА theft если видишь:
- Человек берёт товар/деньги и ПРЯЧЕТ в карман/сумку украдкой
- Характерное воровское движение с оглядкой
- Берёт деньги из кассы/со стола и быстро убирает

❌ НЕ кража:
- Покупатель берёт товар чтобы рассмотреть
- Достаёт кошелёк/телефон чтобы заплатить
- Кассир работает с деньгами по работе
- Человек кладёт свои вещи в свою сумку

═══════════════════════════════════════
ДРУГИЕ РЕАЛЬНЫЕ УГРОЗЫ:
═══════════════════════════════════════
- fall: человек УПАЛ и лежит на полу (не присел, не нагнулся — именно упал/лежит)
- smoking: курит сигарету/вейп с видимым дымом
- child_lost: маленький ребёнок ОДИН, явно без взрослых, потерянный/плачущий
- crowd: реальное скопление 10+ человек
- abandoned_object: сумка/рюкзак БЕЗ людей рядом в общей зоне (брошенная)

УМНЫЙ АНАЛИЗ СУМОК:
- "owner_nearby" — сумка рядом с человеком (1-2м) → НЕ угроза
- "employee_bag" — рабочая сумка сотрудника → НЕ угроза
- "shopper_bag" — пакет покупок у человека → НЕ угроза
- "abandoned_suspicious" — БРОШЕННАЯ без людей рядом → угроза suspicious
- "no_bag" — сумок нет

═══════════════════════════════════════
ИТОГ — когда поднимать тревогу:
═══════════════════════════════════════
✅ Видишь опасный предмет (нож/ножницы/зажигалка/оружие) → сообщай, confidence 0.5+
✅ Видишь огонь/дым/сигарету/вейп → сообщай
✅ Видишь замах/удар/агрессивную позу/защитную реакцию → сообщай fight
✅ Видишь падение/лежащего человека → сообщай fall
✅ Если предмет/действие ПОХОЖЕ на угрозу но не уверен на 100% → всё равно сообщи с confidence 0.5, система перепроверит через premium-модель
❌ Только явно безопасное (спокойно сидят/идут/работают/держат телефон/разговаривают плавно) = is_safe: true

Камера: ${cam.name}. Этаж: ${cam.floor || "—"}.${localHint ? `\nВАЖНО — ЛОКАЛЬНЫЙ ДЕТЕКТОР ДВИЖЕНИЙ СООБЩАЕТ: ${localHint}. Проверь это в кадре особенно внимательно.` : ""}
Сейчас: ${afterHours ? 'ВНЕРАБОЧЕЕ ВРЕМЯ (22:00-06:00) — присутствие людей подозрительно' : 'РАБОЧЕЕ ВРЕМЯ — люди в кадре это норма'}.

Также верни:
- has_child: true/false
- has_adult_near_child: true/false
- abandoned_object: описание брошенного или null
- queue_size: число
- conflict_detected: true/false — РЕАЛЬНЫЙ физический конфликт (не разговор)
- suspicious_movement: true/false — явное воровское сокрытие предмета
- bag_context: owner_nearby/employee_bag/shopper_bag/abandoned_suspicious/no_bag
- scene_description: ПОДРОБНОЕ описание ВСЕГО что видишь в кадре

Отвечай ТОЛЬКО JSON без markdown:
{
  "people_count": число,
  "is_safe": true/false,
  "has_child": true/false,
  "has_adult_near_child": true/false,
  "abandoned_object": null или "описание",
  "queue_size": число,
  "conflict_detected": true/false,
  "suspicious_movement": true/false,
  "bag_context": "тип_сумки",
  "threats": [
    {"type":"knife|weapon|scissors|gun|fire|lighter|smoking|fight|theft|fall|crowd|aggression|child_lost|abandoned_object|after_hours|phone_at_work|queue|suspicious|vandalism","severity":"low|medium|high|critical","confidence":0.0-1.0,"description":"что именно видишь"}
  ],
  "scene_description":"подробное описание сцены"
}`;

  // пункты регламента, которым пора сработать на этом кадре
  const promptWithChecks = prompt + compliance.promptFor(checks);

  const dataUrl = 'data:image/jpeg;base64,' + base64;

  const CRITICAL_TYPES = new Set(['fire', 'lighter', 'smoke', 'knife', 'weapon', 'scissors', 'blade', 'gun', 'fight']);

  let result = null;
  let usedProvider = null;

  // ═══ ЯРУС 0: ЛОКАЛЬНАЯ VLM (Фаза 3) — кадр не покидает объект, $0 ═══
  if (LOCAL_VLM_URL) {
    try {
      result = await localVlmAnalyze({
        baseUrl: LOCAL_VLM_URL,
        model: LOCAL_VLM_MODEL,
        prompt: compactPrompt(cam, localHint, afterHours),
        base64,
        timeoutMs: parseInt(LOCAL_VLM_TIMEOUT_MS),
      });
      usedProvider = 'local-vlm';
    } catch (e) {
      if (RT.LOCAL_ONLY) {
        log(`  🔴 Локальный VLM недоступен (${e.message}) — LOCAL_ONLY: облако НЕ вызываю`);
        warnLocalVlmDown(e.message);
        return { people_count: 0, is_safe: true, threats: [], scene_description: 'локальный VLM недоступен, кадр не анализирован' };
      }
      log(`  ⚠️ Локальный VLM: ${e.message} — переключаюсь на облако`);
    }
  }

  // Страховка LOCAL_ONLY: до облачных ярусов дойти невозможно
  if (RT.LOCAL_ONLY && !result) {
    return { people_count: 0, is_safe: true, threats: [], scene_description: 'LOCAL_ONLY: анализ только локальной VLM' };
  }

  // 🛑 ПРЕДОХРАНИТЕЛЬ ДЕНЕГ: жёсткий потолок облачных вызовов на камеру в час.
  // Ловит ЛЮБУЮ будущую ошибку логики до того, как она станет счётом.
  if (!result) {
    const b = cloudBudget.take(cam.id);
    if (!b.ok) {
      log(`  🛑 Лимит облака ${RT.MAX_CLOUD_PER_CAM_HOUR}/час для "${cam.name}" исчерпан — вызов пропущен`);
      if (b.firstDenial) {
        sendTelegramText(`🛑 <b>SafeZone: сработал предохранитель</b>\nКамера «${cam.name}» упёрлась в лимит ${RT.MAX_CLOUD_PER_CAM_HOUR} облачных анализов за час — вызовы приостановлены до конца часа.\nЕсли это неожиданно — глянь логи: возможно, в кадре статичная «угроза» или зациклилась логика.`);
      }
      return { people_count: 0, is_safe: true, threats: [], scene_description: 'предохранитель: лимит облачных вызовов на час исчерпан' };
    }
  }

  if (OPENROUTER_API_KEY) {

    const orModels = [OPENROUTER_MODEL + ':free', OPENROUTER_MODEL];
    for (const orModel of orModels) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + OPENROUTER_API_KEY,
            'HTTP-Referer': 'https://safezone.kz',
            'X-Title': 'SafeZone',
          },
          body: JSON.stringify({
            model: orModel,
            max_tokens: 800, temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: [
              { type: 'text', text: promptWithChecks },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
            ] }],
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (res.ok) {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content || '{}';
          const m = text.match(/\{[\s\S]*\}/);
          result = m ? JSON.parse(m[0]) : null;
          if (result) { usedProvider = orModel.includes(':free') ? 'openrouter-free' : 'openrouter-paid'; break; }
        } else if (res.status === 429) {

          if (orModel.includes(':free')) { log(`  ⏭ OpenRouter free лимит — перехожу на платную Gemma 4 (копейки)`); continue; }
          const errText = await res.text();
          log(`  ⚠️ OpenRouter ${res.status}: ${errText.slice(0, 100)} — пробуем Gemini`);
        } else {
          const errText = await res.text();
          log(`  ⚠️ OpenRouter ${res.status}: ${errText.slice(0, 100)} — пробуем Gemini`);
          break;
        }
      } catch (e) {
        log(`  ⚠️ OpenRouter error: ${e.message} — пробуем Gemini`);
        break;
      }
    }
  }

  if (!result && GEMINI_KEYS.length > 0) {
    const gkey = nextGeminiKey();
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-goog-api-key': gkey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptWithChecks }, { inline_data: { mime_type: 'image/jpeg', data: base64 } }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 800, responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const m = text.match(/\{[\s\S]*\}/);
        result = m ? JSON.parse(m[0]) : null;
        usedProvider = 'gemini';
      } else {
        const errText = await res.text();
        log(`  ⚠️ Gemini ${res.status}: ${errText.slice(0, 120)} — пробуем Groq`);
      }
    } catch (e) {
      log(`  ⚠️ Gemini error: ${e.message} — пробуем Groq`);
    }
  }

  if (!result && GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_API_KEY },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 800, temperature: 0.2, response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: [{ type: 'text', text: promptWithChecks }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '{}';
        const m = text.match(/\{[\s\S]*\}/);
        result = m ? JSON.parse(m[0]) : null;
        usedProvider = 'groq';
      } else {
        const errText = await res.text();
        log(`  ⚠️ Groq ${res.status}: ${errText.slice(0, 120)} — пробуем OpenAI`);
      }
    } catch (e) {
      log(`  ⚠️ Groq error: ${e.message} — пробуем OpenAI`);
    }
  }

  if (!result && OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 800,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptWithChecks }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '{}';
      const m = text.match(/\{[\s\S]*\}/);
      result = m ? JSON.parse(m[0]) : null;
      usedProvider = 'openai';
    }
  }

  if (!result) {
    throw new Error('Все AI-провайдеры недоступны');
  }

  const hasCritical = (result.threats || []).some(t =>
    CRITICAL_TYPES.has(t.type) && (t.confidence || 0) >= 0.3
  );
  if (hasCritical && usedProvider !== 'openai' && OPENAI_API_KEY && !RT.LOCAL_ONLY) {
    const critType = (result.threats || []).filter(t => CRITICAL_TYPES.has(t.type)).map(t => t.type).join(',');
    log(`  🔴 ${usedProvider} нашёл критичное (${critType}) → перепроверяю на OpenAI для точности`);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_API_KEY },
        body: JSON.stringify({
          model: 'gpt-4o-mini', max_tokens: 800,
          messages: [{ role: 'user', content: [{ type: 'text', text: promptWithChecks }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '{}';
        const m = text.match(/\{[\s\S]*\}/);
        const verified = m ? JSON.parse(m[0]) : null;
        if (verified) {
          const stillCritical = (verified.threats || []).some(t => CRITICAL_TYPES.has(t.type) && (t.confidence || 0) >= 0.3);
          if (stillCritical) {
            log(`  ✅ OpenAI ПОДТВЕРДИЛ критичную угрозу`);
            return verified;
          } else {
            log(`  🟢 OpenAI НЕ подтвердил — ложная тревога ${usedProvider}, отбрасываем`);
            return verified;
          }
        }
      }
    } catch (e) {
      log(`  ⚠️ OpenAI verification error: ${e.message} — берём результат ${usedProvider}`);
    }
  }

  return result;
}

const TYPE_MAP = {
  knife: 'weapon', weapon: 'weapon', scissors: 'weapon', blade: 'weapon', gun: 'weapon',
  fire: 'fire', lighter: 'fire', smoke: 'fire', smoking: 'smoking',
  fight: 'fight', theft: 'theft', fall: 'fall', crowd: 'crowd',
  aggression: 'fight', child_lost: 'child_lost', abandoned_object: 'suspicious',
  after_hours: 'suspicious', phone_at_work: 'violation', queue: 'crowd',
  suspicious: 'suspicious', alcohol: 'violation', vandalism: 'vandalism',
  vape: 'smoking', cigarette: 'smoking', cigar: 'smoking', hookah: 'smoking',
};

const SCENARIO_MAP = {
  weapon: 'weapon', fire: 'fire', smoking: 'smoking', fight: 'fight',
  theft: 'theft', fall: 'fall', crowd: 'crowd', child_lost: 'child_lost',
  suspicious: 'suspicious', violation: 'suspicious', vandalism: 'suspicious',
};
const EMOJI = { low: 'ℹ️', medium: '⚠️', high: '🔶', critical: '🚨' };

let lastVlmWarnAt = 0;
function warnLocalVlmDown(detail) {
  const now = Date.now();
  if (now - lastVlmWarnAt < 10 * 60 * 1000) return;
  lastVlmWarnAt = now;
  sendTelegramText(`⚠️ <b>SafeZone: локальный VLM не отвечает</b>\nРежим LOCAL_ONLY — анализ кадров ОСТАНОВЛЕН (облако отключено политикой).\nПроверь: ollama работает? модель ${LOCAL_VLM_MODEL} скачана?\nДеталь: ${String(detail).slice(0, 140)}`);
}

const prevFrames = {};
const lastYolo = {};
const lastCloudAt = {};
const camLocalHint = {};
const forceAnalyzeAt = {};
const suspicionUntil = {};
const sceneFpAtCloud = {};
const failState = {};        // троттлинг логов недоступных камер
const tiledState = {};       // дальнозоркость: счётчик циклов + «прицел» на дальнего   // отпечаток сцены на момент последнего облачного анализа (per cam)
let cloudBudget = new CloudBudget(RT.MAX_CLOUD_PER_CAM_HOUR);

async function frameDiff(buf1, buf2) {
  return new Promise((resolve) => {
    try {
      const ff = spawn('ffmpeg', [
        '-i', 'pipe:3', '-i', 'pipe:4',
        '-filter_complex', 'ssim', '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.stdio[3].write(buf1); ff.stdio[3].end();
      ff.stdio[4].write(buf2); ff.stdio[4].end();
      ff.on('close', () => {
        const m = stderr.match(/All:\s*([0-9.]+)/);
        resolve(m ? (1 - parseFloat(m[1])) * 100 : 100);
      });
      ff.on('error', () => resolve(100));
    } catch { resolve(100); }
  });
}

/** Тревога по зоне: Telegram + БД. Облако НЕ вызывается — правило локальное. */
async function sendZoneAlert(cam, za, jpegBuffer) {
  const icon = za.type === 'uncleaned_table' ? '🍽' : '🔔';
  const caption = `${icon} <b>${za.name}</b>\n${za.description}\n📹 ${cam.name}${cam.floor ? ` · этаж ${cam.floor}` : ''}\n🕐 ${new Date().toLocaleTimeString('ru-RU')}`;
  try {
    await sendTelegramPhoto(jpegBuffer, caption);
  } catch (e) { log(`  ⚠️ zone telegram: ${e.message}`); }

  const { error } = await insertDroppingUnknownColumns(sb, 'events', {
    mall_id: cam.mall_id,
    camera_id: cam.id,
    zone_id: cam.zone_id,
    type: za.type,
    severity: za.severity,
    description: za.description,
    confidence: 1,
    screenshot_base64: jpegBuffer.toString('base64'),
    status: 'new',
  }, log);
  if (error) log(`  ❌ zone DB: ${error.message}`);
  else log(`  ✅ Зонная тревога записана: ${za.type} (облако не вызывалось, $0)`);
}

async function processCamera(cam) {
  const url = buildRtspUrl(cam);
  let jpegBuffer;
  try {
    jpegBuffer = await grabSnapshot(url, cam.id);
  } catch (e) {
    const fs = failState[cam.id];
    if (!fs || Date.now() - fs.at > 300000) {
      log(`[FAIL] ${cam.name}: ${e.message}${fs && fs.n ? ` (и ещё ${fs.n} раз за 5 мин)` : ''}`);
      failState[cam.id] = { at: Date.now(), n: 0 };
      await sb.from('cameras').update({ status: 'offline', updated_at: new Date().toISOString() }).eq('id', cam.id);
    } else {
      fs.n++;
    }
    return;
  }
  failState[cam.id] = null;
  log(`[OK] ${cam.name}: ${Math.round(jpegBuffer.length / 1024)}KB`);

  const base64 = jpegBuffer.toString('base64');
  const { error: camUpdErr } = await sb.from('cameras').update({
    last_frame_base64: base64,
    last_frame_at: new Date().toISOString(),
    status: 'online',
    updated_at: new Date().toISOString(),
  }).eq('id', cam.id);
  if (camUpdErr) {
    log(`  ❌ Camera UPDATE failed: ${camUpdErr.message}`);
  }

  if (!settings.ai_enabled || cam.ai_enabled === false) return;
  if (!OPENROUTER_API_KEY && GEMINI_KEYS.length === 0 && !GROQ_API_KEY && !OPENAI_API_KEY) return;

  let frameToAnalyze = jpegBuffer;
  let rapidMode = false;
  let burstStash = null;
  let sceneChangedForExtend = true; // в MOTION-режиме поведение прежнее // запасные кадры burst-серии для верификации без новых RTSP-подключений

  // Сценарии камеры: не тратим ни цента облака на то, что у камеры ВЫКЛЮЧЕНО
  const enabledSc = Array.isArray(cam.enabled_scenarios) ? new Set(cam.enabled_scenarios) : null;
  const wants = (...keys) => !enabledSc || keys.some(k => enabledSc.has(k));
  const PEOPLE_SCENARIOS = ['theft', 'fight', 'smoking', 'fall', 'crowd', 'child_lost', 'suspicious', 'intrusion', 'weapon'];

  if (RT.YOLO_ENABLED) {
    const now = Date.now();
    const afterHrs = isAfterHours();
    const recentSuspicion = suspicionUntil[cam.id] && now < suspicionUntil[cam.id];
    const forceEvery = 10 * 60 * 1000;
    const needForce = !forceAnalyzeAt[cam.id] || (now - forceAnalyzeAt[cam.id]) > forceEvery;

    let dets = [];
    let fireScore = 0;
    try {
      dets = await yoloDetect(jpegBuffer);
      fireScore = await yoloFireHint(jpegBuffer);
    } catch (e) {
      log(`  ⚠️ YOLO error: ${e.message} — анализируем облаком на всякий случай`);
      dets = null;
    }

    if (dets !== null) {
      // === 🔭 ДАЛЬНОЗОРКОСТЬ: тайловый проход для людей на дальнем плане ===
      // Полный кадр 640px слеп к людям мельче ~85px. Тайлы видят до ~48px (2x2) / ~37px (3x3).
      // Экономия CPU: скан раз в RT.TILED_EVERY_N циклов на пустой сцене; нашли дальнего —
      // держим «прицел» (каждый цикл), пока он не уйдёт или не приблизится.
      if (RT.TILED_DETECT !== 'off') {
        const ts = (tiledState[cam.id] = tiledState[cam.id] || { n: 0, sticky: false });
        ts.n++;
        const fullPersons = dets.filter(d => d.cls === 'person').length;
        const due = RT.TILED_DETECT === 'always'
          || ts.sticky
          || (fullPersons === 0 && ts.n % Math.max(1, RT.TILED_EVERY_N) === 0);
        if (due) {
          try {
            const far = await tiledDetect(jpegBuffer, yoloDetect, { grid: RT.TILED_GRID });
            dets = mergeDets(dets, far);
            const nowPersons = dets.filter(d => d.cls === 'person').length;
            if (nowPersons > fullPersons) {
              log(`  🔭 Дальний план (${RT.TILED_GRID}x${RT.TILED_GRID}): +${nowPersons - fullPersons} чел, которых полный кадр не видел`);
            }
            ts.sticky = fullPersons === 0 && nowPersons > 0;
          } catch (e) { log(`  ⚠️ tiled: ${e.message}`); }
        } else if (fullPersons > 0) {
          ts.sticky = false;
        }
      }

      // === 📐 ЗОНЫ: локальные правила на таймерах — $0, облако не участвует ===
      if (zoneEngine) {
        try {
          const zoneAlerts = zoneEngine.evaluate(cam, dets, now);
          for (const za of zoneAlerts) {
            log(`  📐 ЗОНА «${za.name}»: ${za.description}`);
            await sendZoneAlert(cam, za, jpegBuffer);
          }
          const pend = zoneEngine.pending(cam, now);
          if (pend.length && !zoneAlerts.length) {
            log(`  ⏳ Зоны тикают: ${pend.map(p => `${p.name} ${p.sec}/${p.need}с`).join(', ')}`);
          }
        } catch (e) { log(`  ⚠️ zones: ${e.message}`); }
      }

      const persons = dets.filter(d => d.cls === 'person').length;
      const danger = dets.filter(d => ['knife', 'scissors', 'fork', 'baseball bat'].includes(d.cls));
      const bags = dets.filter(d => ['backpack', 'handbag', 'suitcase'].includes(d.cls));
      const prev = lastYolo[cam.id] || { persons: 0, bags: 0 };
      lastYolo[cam.id] = { persons, bags: bags.length, ts: now };

      // === ТРЕКЕР: стабильные ID, скорости, лойтеринг, брошенные вещи — локально, $0 ===
      let thAbandoned = null, thLoiter = null, thRunning = null;
      if (RT.LOCAL_TRACKER) {
        const tracker = getTracker(cam.id);
        tracker.update(dets.filter(d => d.cls === 'person' || ['backpack', 'handbag', 'suitcase'].includes(d.cls)), now);
        const trackHints = tracker.sceneHints(now, { loiterSec: RT.LOITER_SEC, abandonedSec: RT.ABANDONED_LOCAL_SEC });
        thAbandoned = trackHints.find(h => h.type === 'abandoned_local');
        thLoiter = trackHints.find(h => h.type === 'loitering');
        thRunning = trackHints.find(h => h.type === 'running');
      }

      // === СКЕЛЕТНОЕ ЗРЕНИЕ: быстрый предпросмотр по одному кадру ===
      let action = { hints: [], calm: false, wristSpeed: 0 };
      let poseAspect = 16 / 9;
      if (persons > 0) {
        try {
          const pr = await poseDetect(jpegBuffer);
          poseAspect = pr.aspect;
          action = analyzeActions(cam.id, pr.persons, now, pr.aspect);
        } catch (e) { log(`  ⚠️ pose error: ${e.message}`); }
      }
      const actFall = action.hints.find(h => h.type === 'fall');
      const actFight = action.hints.find(h => h.type === 'fight_signal');
      const actSmoke = action.hints.find(h => h.type === 'hand_to_mouth');
      const trackDetails = [thAbandoned, thLoiter, thRunning].filter(Boolean).map(h => h.detail);
      const allHints = [...action.hints.map(h => h.detail), ...trackDetails];
      camLocalHint[cam.id] = allHints.length ? allHints.join('; ') : null;

      const detStr = dets.map(d => `${d.cls}:${(d.conf * 100) | 0}%`).join(', ') || 'пусто';
      const possibleFire = fireScore > 0.012;
      const cooldownMs = action.calm ? 90000 : 45000;
      const cloudCooldownOk = !lastCloudAt[cam.id] || (now - lastCloudAt[cam.id]) > cooldownMs;

      // 🧊 Отпечаток сцены: изменилось ли ЧТО-ЛИБО с последнего облачного анализа
      const sceneFp = buildSceneFp(dets, possibleFire);
      const lastFpRec = sceneFpAtCloud[cam.id];
      const sceneChanged = !lastFpRec || lastFpRec.fp !== sceneFp;
      const staticRecheckDue = !lastFpRec || (now - lastFpRec.at) > RT.STATIC_RECHECK_MIN * 60000;
      sceneChangedForExtend = sceneChanged;

      let reason = null;
      if (danger.length && wants('weapon')) { reason = `⚠️ ОПАСНЫЙ ПРЕДМЕТ: ${danger.map(d => d.cls).join(',')}`; rapidMode = true; }
      else if (possibleFire && wants('fire')) { reason = `🔥 Возможен огонь (${(fireScore * 100).toFixed(1)}% пикселей)`; rapidMode = true; }
      else if (actFall && wants('fall')) { reason = `🤕 СКЕЛЕТ: похоже на падение (${actFall.detail})`; rapidMode = true; }
      else if (actFight && wants('fight')) { reason = `👊 СКЕЛЕТ: признаки драки (${actFight.detail})`; rapidMode = true; }
      else if (actSmoke && wants('smoking')) { reason = `🚬 СКЕЛЕТ: жест курения (${actSmoke.detail})`; }
      else if (recentSuspicion && sceneChanged && cloudCooldownOk && wants(...PEOPLE_SCENARIOS, 'fire')) { reason = '👁 Продолжаю наблюдение (сцена изменилась)'; rapidMode = true; }
      else if (thRunning && afterHrs && wants('intrusion', 'suspicious', 'theft')) { reason = `🏃 ТРЕКЕР: ${thRunning.detail} (нерабочее время)`; rapidMode = true; }
      else if (thLoiter && afterHrs && wants('suspicious', 'intrusion')) { reason = `🧍 ТРЕКЕР: ${thLoiter.detail} (нерабочее время)`; rapidMode = true; }
      else if (persons > 0 && afterHrs && wants('intrusion', 'suspicious')) { reason = `🌙 Человек в нерабочее время`; rapidMode = true; }
      else if (thAbandoned && wants('suspicious', 'theft')) { reason = `🎒 ТРЕКЕР: ${thAbandoned.detail}`; }
      else if (persons > 0 && prev.persons === 0 && wants(...PEOPLE_SCENARIOS)) { reason = `👤 Появился человек (${persons})`; }
      else if (persons !== prev.persons && persons > 0 && wants(...PEOPLE_SCENARIOS)) { reason = `👥 Изменилось число людей: ${prev.persons}→${persons}`; }
      else if (bags.length > 0 && persons === 0 && wants('suspicious', 'theft')) { reason = `🎒 Сумка без людей рядом`; }
      else if (persons > 0 && cloudCooldownOk && wants(...PEOPLE_SCENARIOS)) { reason = action.calm ? `⏱ Плановый (люди спокойны, редкий режим)` : `⏱ Плановый анализ при людях`; }
      else if (needForce && wants(...PEOPLE_SCENARIOS, 'fire')) { reason = '⏰ Плановая проверка'; }

      // 📋 РЕГЛАМЕНТ: пункты со своей периодичностью (раз в 30/60 минут).
      // Отдельный повод, независимый от сценариев безопасности.
      const dueChecks = compliance.due(cam.id);
      if (!reason && dueChecks.length) {
        reason = `📋 Регламент: ${dueChecks.map(c => c.code).join(', ')}`;
      }

      if (!reason) {
        const scSkipped = enabledSc && (danger.length || possibleFire || actFall || actFight || actSmoke || persons > 0);
        const next = compliance.nextInMinutes(cam.id);
        const nextStr = next === null ? '' : `, регламент через ${next} мин`;
        log(`  💤 YOLO: ${detStr}${action.calm ? ' (спокойны)' : ''} — облако не нужно${scSkipped ? ' (сценарий выключен у камеры)' : ''}${nextStr}, $0`);
        return;
      }

      // 🧊 ПРЕДОХРАНИТЕЛЬ: та же сцена уже анализировалась — нового знания облако не даст.
      // Плановую проверку (⏰) пропускаем как есть — её работа и есть периодический контроль.
      if (!sceneChanged && !staticRecheckDue && !reason.startsWith('⏰') && !reason.startsWith('📋')) {
        log(`  🧊 YOLO: ${detStr} — сцена не изменилась с прошлого анализа [${reason}] — $0 (статика, перепроверка раз в ${RT.STATIC_RECHECK_MIN} мин)`);
        return;
      }

      // === BURST: при rapid-триггере снимаем серию кадров и анализируем ДИНАМИКУ локально ===
      if (rapidMode && RT.BURST_ENABLED && persons > 0) {
        try {
          const burst = await grabBurst(url, cam.id, { frames: RT.BURST_FRAMES, fps: RT.BURST_FPS });
          const framesPersons = [];
          for (const fb of burst.buffers) {
            try { framesPersons.push((await poseDetect(fb)).persons); }
            catch { framesPersons.push([]); }
          }
          const seq = analyzeBurstPoses(cam.id, framesPersons, burst.timestamps, poseAspect);
          if (seq.hints.length) {
            camLocalHint[cam.id] = seq.hints.map(h => h.detail).join('; ');
            log(`  🎬 BURST ${burst.buffers.length} кадров: ${camLocalHint[cam.id]}`);
          } else if (seq.calm) {
            log(`  🎬 BURST ${burst.buffers.length} кадров: движения спокойные (${seq.wristSpeed.toFixed(2)} роста/с)`);
          }
          frameToAnalyze = burst.buffers[seq.bestFrameIdx] || jpegBuffer;
          burstStash = burst.buffers.filter((_, i) => i !== seq.bestFrameIdx);
        } catch (e) {
          log(`  ⚠️ burst не снялся (${e.message}) — работаю по одному кадру`);
        }
      }

      log(`  🧠 YOLO: ${detStr} → ${reason} → облако`);
      lastCloudAt[cam.id] = now;
      sceneFpAtCloud[cam.id] = { fp: sceneFp, at: now };
      if (needForce) forceAnalyzeAt[cam.id] = now;
    }
  } else if (RT.MOTION_ENABLED) {
    const prev = prevFrames[cam.id];
    const now = Date.now();
    const forceEvery = 60 * 1000;
    const needForce = !forceAnalyzeAt[cam.id] || (now - forceAnalyzeAt[cam.id]) > forceEvery;

    const recentSuspicion = suspicionUntil[cam.id] && now < suspicionUntil[cam.id];

    if (prev && !needForce) {
      const diff = await frameDiff(prev.buffer, jpegBuffer);
      prevFrames[cam.id] = { buffer: jpegBuffer, ts: now };
      if (diff < RT.MOTION_THRESHOLD && !recentSuspicion) {
        log(`  💤 Нет движения (diff=${diff.toFixed(1)}%) — пропуск AI, экономим`);
        return;
      }

      const RAPID_THRESHOLD = 2.0;
      if (diff >= RAPID_THRESHOLD || recentSuspicion) {
        rapidMode = true;
        log(`  ⚡ ${recentSuspicion ? 'Продолжаю наблюдение' : 'Активное движение'} (diff=${diff.toFixed(1)}%) — RAPID, серия анализов`);
      } else {
        log(`  🏃 Движение (diff=${diff.toFixed(1)}%) — анализируем`);
      }
    } else {
      prevFrames[cam.id] = { buffer: jpegBuffer, ts: now };
      if (needForce) { forceAnalyzeAt[cam.id] = now; log(`  ⏰ Плановая проверка`); }
    }
  }

  let result;
  try {
    if (rapidMode) {

      result = await analyzeFrame(frameToAnalyze, cam, camLocalHint[cam.id], dueChecks);
      let bestThreatLevel = (result.threats || []).length;

      if (RT.LOCAL_ONLY) {
        // Локальный режим: динамика уже проверена скелетами по всей серии,
        // доп. VLM-взгляды только затянут тревогу (VLM на CPU = 5-30с/кадр)
        log(`  ⚡ LOCAL_ONLY: доп. взгляды пропускаю — burst-динамика уже проанализирована`);
      } else if (burstStash && burstStash.length) {
        // Серия уже снята — доп. облачные взгляды берём из неё,
        // и ТОЛЬКО если первый взгляд что-то нашёл (было: всегда 4 вызова, стало: 1-3)
        if (bestThreatLevel > 0) {
          for (const extraBuf of burstStash.slice(-2)) {
            let extraResult;
            try { extraResult = await analyzeFrame(extraBuf, cam, camLocalHint[cam.id]); } catch { continue; }
            const lvl = (extraResult.threats || []).length;
            const hasCrit = (extraResult.threats || []).some(t => (t.confidence || 0) >= 0.3);
            if (lvl > bestThreatLevel || (hasCrit && !(result.threats || []).some(t => (t.confidence || 0) >= 0.4))) {
              result = extraResult;
              frameToAnalyze = extraBuf;
              bestThreatLevel = lvl;
              log(`  ⚡ BURST-кадр: угроза виднее, берём его`);
            }
          }
        }
      } else {
        // burst выключен или не снялся — прежнее поведение
        const rapidUrl = buildRtspUrl(cam);
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 1200));
          let extraBuf, extraResult;
          try {
            extraBuf = await grabSnapshot(rapidUrl, cam.id);
            extraResult = await analyzeFrame(extraBuf, cam, camLocalHint[cam.id]);
          } catch { continue; }
          const lvl = (extraResult.threats || []).length;
          const hasCrit = (extraResult.threats || []).some(t => (t.confidence || 0) >= 0.3);

          if (lvl > bestThreatLevel || (hasCrit && !(result.threats || []).some(t => (t.confidence || 0) >= 0.4))) {
            result = extraResult;
            frameToAnalyze = extraBuf;
            bestThreatLevel = lvl;
            log(`  ⚡ RAPID кадр ${i + 2}: найдена угроза, берём этот кадр`);
          }
        }
      }
    } else {
      result = await analyzeFrame(frameToAnalyze, cam, camLocalHint[cam.id], dueChecks);
    }
    // пункты отработали — следующий раз не раньше их интервала
    if (dueChecks.length) compliance.markRun(cam.id, dueChecks);
  } catch (e) {
    log(`[AI ERR] ${cam.name}: ${e.message}`);
    return;
  }
  forceAnalyzeAt[cam.id] = Date.now();

  const threats = result.threats || [];
  const afterHours = isAfterHours();
  log(`${cam.name}: people=${result.people_count || 0} safe=${result.is_safe} threats=${threats.length}${afterHours ? ' [AFTER-HOURS]' : ''}`);

  const anySuspicion = threats.length > 0 || result.conflict_detected || result.suspicious_movement
    || (result.scene_description && /сигарет|вейп|нож|ножниц|зажигалк|огонь|дым|удар|замах|драк|агресс|пада|лежит|оруж/i.test(result.scene_description));
  if (anySuspicion && sceneChangedForExtend) {
    suspicionUntil[cam.id] = Date.now() + 30000;
  }
  // сцена статична → наблюдение НЕ продлеваем: пусть истечёт,
  // иначе неподвижная «угроза» (сумка на подоконнике) крутит облако вечно

  if (result.scene_description) {
    log(`  📷 Сцена: ${result.scene_description}`);
  }
  if (result.bag_context && result.bag_context !== 'no_bag') {
    log(`  🎒 Сумка: ${result.bag_context}`);
  }
  if (result.conflict_detected) {
    log(`  ⚠️ Обнаружен конфликт между людьми`);
  }
  if (result.suspicious_movement) {
    log(`  💰 Подозрительное движение "со стола в карман"`);
  }
  if (threats.length > 0) {
    for (const t of threats) {
      log(`  ⚡ Угроза: ${t.type} [${t.severity}] conf=${t.confidence} — ${t.description}`);
    }
  }
  if (result.has_child) {
    log(`  👶 Ребёнок в кадре, взрослый рядом: ${result.has_adult_near_child}`);
  }
  if (result.abandoned_object) {
    log(`  🎒 Брошенный предмет: ${result.abandoned_object}`);
  }

  if (result.conflict_detected === true) {
    const hasFightThreat = threats.some(t => t.type === 'fight' || t.type === 'aggression');
    if (!hasFightThreat) {
      threats.push({
        type: 'fight', severity: 'high', confidence: 0.7,
        description: 'Обнаружен конфликт между людьми в кадре',
      });
    }
  }

  if (result.suspicious_movement === true) {
    const hasTheftThreat = threats.some(t => t.type === 'theft');
    if (!hasTheftThreat) {
      threats.push({
        type: 'theft', severity: 'high', confidence: 0.75,
        description: 'Подозрительное движение: человек резко взял предмет со стола и спрятал в карман',
      });
    }
  }

  if (result.bag_context === 'abandoned_suspicious') {
    const hasAbandonedThreat = threats.some(t => t.type === 'abandoned_object');
    if (!hasAbandonedThreat) {
      threats.push({
        type: 'abandoned_object', severity: 'high', confidence: 0.8,
        description: 'Брошенная подозрительная сумка без хозяина в зоне',
      });
    }
  }

  if (afterHours && (result.people_count || 0) > 0) {
    threats.push({
      type: 'after_hours', severity: 'high', confidence: 0.9,
      description: `AfterHoursPresence: в зоне ${result.people_count} человек после 22:00`,
    });
  }

  if (result.abandoned_object) {
    if (!abandonedObjects[cam.id]) {
      abandonedObjects[cam.id] = { since: Date.now(), alertedAt: 0, description: result.abandoned_object };
      log(`🎒 ABANDONED on ${cam.name}: ${result.abandoned_object} — timer started`);
    } else {
      const sinceFor = Math.floor((Date.now() - abandonedObjects[cam.id].since) / 1000);
      const sinceLastAlert = Date.now() - abandonedObjects[cam.id].alertedAt;
      if (sinceFor >= ABANDONED_OBJECT_SEC && sinceLastAlert > 300000) {
        threats.push({
          type: 'abandoned_object', severity: 'high', confidence: 0.85,
          description: `AbandonedObject: ${abandonedObjects[cam.id].description} лежит без хозяина уже ${sinceFor} сек`,
        });
        abandonedObjects[cam.id].alertedAt = Date.now();
      }
    }
  } else {
    if (abandonedObjects[cam.id]) delete abandonedObjects[cam.id];
  }

  if (result.has_child === true && result.has_adult_near_child === false) {
    if (!lonelyChild[cam.id]) {
      lonelyChild[cam.id] = { since: Date.now(), alertedAt: 0 };
      log(`👶 LONELY CHILD on ${cam.name} — timer started`);
    } else {
      const aloneFor = Math.floor((Date.now() - lonelyChild[cam.id].since) / 1000);
      const sinceLastAlert = Date.now() - lonelyChild[cam.id].alertedAt;
      if (aloneFor >= LONELY_CHILD_THRESHOLD_SEC && sinceLastAlert > 300000) {
        threats.push({
          type: 'child_lost', severity: 'critical', confidence: 0.9,
          description: `Ребёнок один без взрослых уже ${Math.floor(aloneFor / 60)} мин`,
        });
        lonelyChild[cam.id].alertedAt = Date.now();
      }
    }
  } else {
    if (lonelyChild[cam.id]) delete lonelyChild[cam.id];
  }

  if (result.queue_size && result.queue_size > 5) {
    threats.push({
      type: 'queue', severity: 'medium', confidence: 0.8,
      description: `QueueMonitor: очередь ${result.queue_size} человек`,
    });
  }

  const NEEDS_VERIFICATION = new Set(['fight', 'aggression', 'theft']);

  for (const threat of threats) {
    if (!threat) continue;
    if ((threat.confidence || 0) < settings.ai_confidence) {
      log(`  ⏭ SKIP по confidence: ${threat.type} conf=${threat.confidence} < ${settings.ai_confidence}`);
      continue;
    }
    const mappedType = TYPE_MAP[threat.type] || 'suspicious';

    if (Array.isArray(cam.enabled_scenarios)) {
      const scenarioKey = SCENARIO_MAP[mappedType] || mappedType;
      if (!cam.enabled_scenarios.includes(scenarioKey)) {
        log(`  🔕 ${cam.name}: сценарий "${scenarioKey}" выключен в настройках камеры — пропуск`);
        continue;
      }
    }

    const key = `${cam.id}_${mappedType}`;
    const now = Date.now();
    if (lastAlerts[key] && (now - lastAlerts[key]) < settings.ai_cooldown_sec * 1000) {
      log(`  ⏭ COOLDOWN skip: ${cam.name} ${mappedType}`);
      continue;
    }

    if (NEEDS_VERIFICATION.has(threat.type)) {
      const verifySource = burstStash && burstStash.length >= 2 ? [...burstStash] : null;
      log(`  🔍 ВЕРИФИКАЦИЯ ${threat.type} — ${verifySource ? 'кадры из burst-серии' : 'ещё 2 кадра с интервалом 1 сек'}...`);
      let confirmCount = 1;
      let lastVerifyBuffer = frameToAnalyze;

      for (let i = 0; i < 2; i++) {
        let verifyBuf;
        if (verifySource && verifySource.length) {
          verifyBuf = verifySource.shift();
        } else {
          await new Promise(r => setTimeout(r, 1000));
          try {
            verifyBuf = await grabSnapshot(buildRtspUrl(cam), cam.id);
          } catch (e) {
            log(`  ⚠️ Кадр ${i + 2} не получен: ${e.message}`);
            continue;
          }
        }
        let verifyResult;
        try {
          verifyResult = await analyzeFrame(verifyBuf, cam);
        } catch (e) {
          log(`  ⚠️ Анализ кадра ${i + 2} упал: ${e.message}`);
          continue;
        }
        const stillThreatening = (verifyResult.threats || []).some(t =>
          t.type === threat.type && (t.confidence || 0) >= settings.ai_confidence
        );
        if (stillThreatening) {
          confirmCount++;
          lastVerifyBuffer = verifyBuf;
          log(`  ✓ Кадр ${i + 2}: ${threat.type} подтверждён (${confirmCount}/3)`);
        } else {
          log(`  ✗ Кадр ${i + 2}: ${threat.type} НЕ подтверждён (${confirmCount}/3)`);
        }
      }

      if (confirmCount < 2) {
        log(`  🟢 ЛОЖНАЯ ТРЕВОГА: ${threat.type} только в ${confirmCount}/3 кадрах — пропускаем`);
        continue;
      }
      log(`  🔴 РЕАЛЬНАЯ УГРОЗА: ${threat.type} подтверждён в ${confirmCount}/3 кадрах — шлём тревогу!`);
      jpegBuffer = lastVerifyBuffer;
    } else {
      jpegBuffer = frameToAnalyze;
    }

    lastAlerts[key] = now;
    runtime.alerts++;

    const { error: insertErr } = await insertDroppingUnknownColumns(sb, 'events', {
      mall_id: cam.mall_id,
      camera_id: cam.id,
      zone_id: cam.zone_id,
      type: mappedType,
      severity: threat.severity || 'medium',
      description: threat.description,
      confidence: threat.confidence,
      screenshot_base64: jpegBuffer.toString('base64'),
      status: 'new',
    }, log);
    if (insertErr) {
      log(`  ❌ DB INSERT FAILED: ${insertErr.message} (code: ${insertErr.code}, hint: ${insertErr.hint || '-'})`);
    } else {
      log(`  ✅ Event saved to DB: ${mappedType} ${threat.severity}`);
    }

    const caption =
      `${EMOJI[threat.severity] || '⚠️'} <b>SafeZone — ТРЕВОГА</b>\n\n` +
      `<b>Камера:</b> ${cam.name}\n` +
      `<b>Сценарий:</b> ${threat.type}\n` +
      `<b>Уровень:</b> ${(threat.severity || '').toUpperCase()}\n` +
      `<b>Описание:</b> ${threat.description}\n` +
      `<b>Точность:</b> ${Math.round((threat.confidence || 0) * 100)}%\n` +
      `<b>Людей в кадре:</b> ${result.people_count || 0}`;

    await sendTelegramPhoto(jpegBuffer, caption);
    log(`>>> ALERT: ${cam.name} ${threat.severity} ${threat.type} — ${threat.description}`);
  }
}

/** Применяет новый конфиг и делает побочные эффекты (пересборка зон/бюджета) */
function applyConfig(dbConfig, quiet = false) {
  const next = buildConfig(process.env, dbConfig);
  const changes = diffConfig(RT, next);
  if (!changes.length) return;
  RT = next;

  if (changes.some(c => ['ZONES_ENABLED','DISH_CLASSES','ZONE_GRACE_SEC'].includes(c.key))) rebuildZoneEngine();
  if (changes.some(c => c.key === 'MAX_CLOUD_PER_CAM_HOUR')) cloudBudget.setMax(RT.MAX_CLOUD_PER_CAM_HOUR);

  if (!quiet) {
    for (const c of changes) {
      log(`  ⚙️ ${c.key}: ${c.from} → ${c.to}${c.restart ? ' (применится после перезапуска бриджа)' : ''}`);
    }
    const needRestart = changes.filter(c => c.restart);
    if (needRestart.length && tgToken) {
      sendTelegramText(`⚙️ <b>Настройки изменены в панели</b>\nТребуют перезапуска бриджа: ${needRestart.map(c => c.key).join(', ')}`).catch(() => {});
    }
  }
}

/** Настройки функций из панели. Нет таблицы → молча работаем на .env, как раньше. */
let settingsTableMissing = false;
async function loadBridgeSettings() {
  if (!mallId || settingsTableMissing) return;
  const { data, error } = await sb.from('bridge_settings').select('config').eq('mall_id', mallId).maybeSingle();
  if (error) {
    if (/relation|does not exist|schema cache|PGRST205|PGRST20/i.test(error.message || '')) {
      settingsTableMissing = true;
      log('⚙️ Таблицы bridge_settings нет — настройки берутся из .env. Применить MIGRATION-v7.7-settings.sql, чтобы управлять из панели.');
    }
    return;
  }
  applyConfig(data?.config || null);
}

async function loadSettings() {
  if (!mallId) return;
  // В режиме привязки настройки функций приходят вместе с heartbeat.
  // Читать их ещё раз из таблицы нельзя: два источника перетирали друг друга
  // каждый цикл, а вместе с ними обнулялся счётчик облачных вызовов.
  if (!bridgeToken) await loadBridgeSettings();
  const { data } = await sb.from('malls').select('ai_enabled, ai_interval_sec, ai_confidence, ai_cooldown_sec').eq('id', mallId).maybeSingle();
  if (!data) return;
  const newInterval = data.ai_interval_sec || settings.ai_interval_sec;
  const intervalChanged = newInterval !== settings.ai_interval_sec;
  settings = {
    ai_enabled: data.ai_enabled ?? true,
    ai_interval_sec: newInterval,
    ai_confidence: parseFloat(data.ai_confidence) || 0.4,
    ai_cooldown_sec: data.ai_cooldown_sec || 120,
  };
  if (intervalChanged && intervalRef) {
    clearInterval(intervalRef);
    intervalRef = setInterval(loop, settings.ai_interval_sec * 1000);
    log(`Interval changed → ${settings.ai_interval_sec}s`);
  }
}

const runtime = { startedAt: Date.now(), cycles: 0, cameras: 0, alerts: 0, lastError: null };
let heartbeatFails = 0;

/** Отмечается на объекте: панель видит «на связи», в ответ прилетают свежие зоны и настройки. */
async function sendHeartbeat() {
  if (!bridgeToken) return;
  try {
    const payload = await heartbeat(sb, bridgeToken, {
      version: BRIDGE_VERSION,
      uptime_sec: Math.round((Date.now() - runtime.startedAt) / 1000),
      cycles: runtime.cycles,
      cameras: runtime.cameras,
      alerts: runtime.alerts,
      detector: RT.DETECTOR,
      pose: RT.POSE_MODEL,
      zones: zoneEngine ? zoneEngine.rules.length : 0,
      last_error: runtime.lastError,
    });
    applyBridgePayload(payload);
    heartbeatFails = 0;
  } catch (e) {
    heartbeatFails++;
    // одна строка на пять неудач: не засоряем лог при коротком обрыве связи
    if (heartbeatFails === 1 || heartbeatFails % 5 === 0) {
      log(`heartbeat: ${e.message} (подряд ${heartbeatFails}) — работаю на последних известных настройках`);
    }
  }
}

async function loop() {
  runtime.cycles++;
  await sendHeartbeat();
  await loadSettings();
  if (commandRunner) commandRunner.tick().catch(e => log(`команды: ${e.message}`));
  let q = sb.from('cameras').select('*').eq('is_active', true);
  if (mallId) q = q.eq('mall_id', mallId);
  const { data: cams, error } = await q;
  if (error) { runtime.lastError = error.message; log(`DB error: ${error.message}`); return; }
  runtime.cameras = cams?.length || 0;
  runtime.lastError = null;
  if (!cams?.length) { log('No active cameras'); return; }

  await Promise.allSettled(cams.map(cam => processCamera(cam)));
}

function printBanner() {
  log(`=== SafeZone Bridge ${BRIDGE_VERSION} — PAIRED (привязка по коду, зоны и настройки из панели) ===`);
  log(`Детектор: ${RT.YOLO_ENABLED ? '✓ ' + RT.DETECTOR + ' | Позы: ' + RT.POSE_MODEL + ' — на этом компьютере (бесплатно, без интернета)' : '✗ выключен'}`);
  log(`Трекер: ${RT.LOCAL_TRACKER ? '✓ ID/скорости/лойтеринг/брошенные вещи локально' : '✗'} | Burst: ${RT.BURST_ENABLED ? `✓ ${RT.BURST_FRAMES} кадров @ ${RT.BURST_FPS} fps при тревоге` : '✗'}`);
  log(`Облако (только при детекте): OpenRouter ${OPENROUTER_API_KEY ? '✓ ' + OPENROUTER_MODEL : '✗'} | Gemini ×${GEMINI_KEYS.length} | Groq ${GROQ_API_KEY ? '✓' : '✗'} | OpenAI ${OPENAI_API_KEY ? '✓' : '✗'}`);
  log(`Дальнозоркость: ${RT.TILED_DETECT !== 'off' ? `✓ тайлы ${RT.TILED_GRID}x${RT.TILED_GRID} (${RT.TILED_DETECT}) — люди до ~${RT.TILED_GRID === 3 ? 37 : 48}px` : '✗'}`);
  log(`Настройки функций: панель + .env — живых параметров ${Object.keys(SCHEMA).length}`);
  log(`Команды из панели: ✓ через Supabase (кнопки работают из облака, без localhost)`);
  log(`API для админки: ${API_ENABLED === 'true' ? `✓ http://${API_HOST}:${API_PORT}` : '✗ выключен'}`);
  log(`Регламент: ${compliance.summary()}`);
  log(`Зоны (локально, $0): ${zoneEngine ? `✓ правил ${zoneEngine.rules.length}: ${zoneEngine.rules.map(r => r.name).join(', ')}` : '✗ нет активных — нарисуй их в панели: Редактор зон'}`);
  log(`Предохранители: 🧊 отпечаток сцены (статика → $0, перепроверка ${RT.STATIC_RECHECK_MIN} мин) | 🛑 лимит ${RT.MAX_CLOUD_PER_CAM_HOUR} обл.вызовов/час/камеру`);
  log(`Локальный VLM: ${LOCAL_VLM_URL ? `✓ ${LOCAL_VLM_MODEL} @ ${LOCAL_VLM_URL}` : '✗ не настроен'}${RT.LOCAL_ONLY ? ' | 🔒 LOCAL_ONLY: кадры НЕ покидают объект, облако отключено' : ''}`);
  log(`Telegram: ${tgToken ? 'YES' : 'NO'} | Chat: ${tgChat || '-'}`);
  log(`After-Hours: ${RT.AFTER_HOURS_START} — ${RT.AFTER_HOURS_END} (now: ${isAfterHours() ? 'AFTER-HOURS' : 'WORK-TIME'})`);
}

function announceStart() {
  if (!tgToken || !tgChat) return;
  sendTelegramText('🟢 <b>SafeZone Bridge ' + BRIDGE_VERSION + ' запущен</b>\n🧠 Локальный ИИ-фильтр смотрит камеры бесплатно на вашем компьютере\n🎬 При тревоге снимает серию кадров и анализирует ДВИЖЕНИЕ: удар, падение, жест — до единого облачного вызова\n📌 Трекер помнит каждого человека и каждую сумку в кадре\n💰 Облако подключается только по включённым сценариям камеры\n\nЛовит:\n🔥 Огонь, зажигалки, ножи, ножницы\n👊 Драки, 💰 кражи, 🤕 падения\n🎒 Брошенные вещи, 🧍 подозрительное топтание, 🌙 люди в нерабочее время').catch(() => {});
}

(async () => {
  if (LEGACY_MODE) {
    log('Режим совместимости: service_key и MALL_ID заданы в .env, привязка не требуется');
  } else {
    try {
      const { state, payload } = await ensureSession({
        sb,
        version: BRIDGE_VERSION,
        platform: platformString(),
        pairingCode: PAIRING_CODE,
        log,
      });
      bridgeToken = state.token;
      applyBridgePayload(payload);
    } catch (e) {
      log('');
      log('✗ Бридж не привязан к объекту.');
      log(`  ${e.message}`);
      log('');
      log('  Как привязать:');
      log('   1. Панель → Бридж → «Добавить бридж» → код из 8 символов');
      log('   2. Впиши его в .env:  PAIRING_CODE=XXXXXXXX');
      log('   3. docker compose restart bridge');
      log(`  Код живёт 24 часа. После привязки состояние лежит в ${statePath()} — не удаляй этот файл.`);
      process.exit(1);
    }
  }

  if (LOCAL_VLM_URL) {
    const ping = await localVlmPing(LOCAL_VLM_URL);
    if (ping.ok) log(`Локальный VLM жив, модели: ${ping.models.join(', ') || '(список пуст)'}`);
    else log(`⚠️ Локальный VLM не отвечает (${ping.detail})${RT.LOCAL_ONLY ? ' — LOCAL_ONLY: анализ работать НЕ будет, подними ollama!' : ' — работаю через облако'}`);
  }
  if (RT.YOLO_ENABLED) {
    const t0 = Date.now();
    try {
      await yoloInit();
      await poseInit();
      log(`Детектор (${RT.DETECTOR}) + позы (${RT.POSE_MODEL}) прогреты за ${Date.now() - t0}ms — готовы фильтровать`);
    } catch (e) {
      log(`⚠️ YOLO не запустился: ${e.message}. Работаю через motion-detection как раньше.`);
    }
  }
  await loadSettings();
  printBanner();
  log(`Initial: enabled=${settings.ai_enabled} interval=${settings.ai_interval_sec}s confidence=${settings.ai_confidence}`);
  announceStart();

  // Команды из панели через Supabase — работает из облака и с телефона,
  // без прямого соединения браузер→localhost
  commandRunner = createCommandRunner({
    sb, mallId, log,
    discoverCameras,
    grabSnapshot,
    detect: (buf) => yoloDetect(buf),
    buildRtspUrl,
  });

  if (API_ENABLED === 'true') {
    startApi({
      version: BRIDGE_VERSION,
      log,
      grabSnapshot,
      detect: (buf) => yoloDetect(buf),
      buildRtspUrl: (b) => buildRtspUrl({
        ip: b.ip, port: b.port || 554, login: b.login || b.user || 'admin',
        password: b.password || b.pass || '', rtsp_path: b.path || b.rtsp_path,
        channel: b.channel || 1, vendor: b.vendor,
      }),
      getStatus: () => ({
        detector: RT.DETECTOR, pose: RT.POSE_MODEL,
        zones: zoneEngine ? zoneEngine.rules.length : 0,
        settings_source: settingsTableMissing ? 'env' : 'db',
        cloud: { openrouter: !!OPENROUTER_API_KEY, gemini: GEMINI_KEYS.length, groq: !!GROQ_API_KEY, openai: !!OPENAI_API_KEY },
      }),
      getSettings: () => ({ schema: uiSchema(), current: { ...RT }, source: settingsTableMissing ? 'env' : 'db' }),
      onSettingsSaved: () => loadBridgeSettings(),
    }, { port: API_PORT, host: API_HOST });
  }

  loop();
  intervalRef = setInterval(loop, settings.ai_interval_sec * 1000);
})();
