const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerSaveBlocker, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const media = require('./media');

// страница дашборда из облака обращается к бриджу и видео на этом же компьютере
app.commandLine.appendSwitch('disable-features', 'PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests');

const TEST_SHOT = process.env.SZ_TEST_SCREENSHOT || '';
if (process.env.SZ_USER_DATA) app.setPath('userData', process.env.SZ_USER_DATA);

function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { supabaseUrl: '', supabaseAnonKey: '', dashboardUrl: 'https://safezone-gamma.vercel.app', apiPort: 8099 }; }
}
const config = loadConfig();
const API_PORT = Number(process.env.SZ_API_PORT || config.apiPort || 8099);

const bridgeDir = process.env.SZ_BRIDGE_DIR
  || (app.isPackaged ? path.join(process.resourcesPath, 'bridge') : path.join(__dirname, '..', 'edge-server', 'bridge'));
const bridgeEntry = process.env.SZ_BRIDGE_ENTRY || path.join(bridgeDir, 'index.js');
const bundledFfmpeg = path.join(process.resourcesPath || '', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const mediaBin = process.env.SZ_MEDIAMTX
  || path.join(process.resourcesPath || '', 'mediamtx', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const mediaAvailable = () => fs.existsSync(mediaBin);
let mediaProc = null, mediaTimer = null, mediaSecrets = null;
const ffmpegPath = app.isPackaged && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : (process.env.FFMPEG_PATH || 'ffmpeg');

let win = null, dashWin = null, tray = null, child = null;

const isWebUrl = (u) => { try { return ['https:', 'http:'].includes(new URL(u).protocol); } catch { return false; } };
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
function openOutside(u) { if (isWebUrl(u)) shell.openExternal(u); }
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'local-network-access', 'local-network', 'loopback-network']);
let quitting = false, restartTimer = null, restartDelay = 5000, pollTimer = null;
const logLines = [];
const state = { phase: 'starting', error: '', health: null, online: false, logs: logLines, configured: !!(config.supabaseUrl && config.supabaseAnonKey) || !!process.env.SZ_BRIDGE_ENTRY };

const dataDir = () => app.getPath('userData');
const stateFile = () => path.join(dataDir(), 'state.json');
const isPaired = () => { try { return !!JSON.parse(fs.readFileSync(stateFile(), 'utf8')).token; } catch { return false; } };

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  if (tray) tray.setToolTip(`SafeZone Bridge: ${phaseLabel()}`);
}
function phaseLabel() {
  return { starting: 'запуск', unpaired: 'не привязан', pairing: 'привязка', running: 'работает', blocked: 'доступ закрыт', stopped: 'остановлен' }[state.phase] || state.phase;
}
function addLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    logLines.push(line.slice(0, 400));
    if (logLines.length > 300) logLines.shift();
  }
}

function startMedia() {
  if (!mediaAvailable() || mediaProc || quitting) return;
  try {
    mediaSecrets = mediaSecrets || media.ensureMediaSecrets(dataDir());
    const cfg = path.join(dataDir(), 'mediamtx.yml');
    fs.writeFileSync(cfg, media.mediamtxConfig({ bridgeApiPort: API_PORT, origins: [config.dashboardUrl] }));
    mediaProc = spawn(mediaBin, [cfg], { cwd: dataDir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const onOut = (buf) => { addLog(String(buf).split(/\r?\n/).filter(Boolean).map(l => `видео: ${l}`).join('\n')); };
    mediaProc.stdout.on('data', onOut);
    mediaProc.stderr.on('data', onOut);
    mediaProc.on('error', (e) => { addLog(`видеосервер не запустился: ${e.message}`); });
    const mine = mediaProc;
    mediaProc.on('exit', (code) => {
      if (mediaProc !== mine) return;
      mediaProc = null;
      if (quitting) return;
      addLog(`видеосервер остановился (код ${code}), перезапуск через 5 с`);
      mediaTimer = setTimeout(startMedia, 5000);
    });
  } catch (e) {
    addLog(`видеосервер не запустился: ${e.message}`);
  }
}

function stopMedia() {
  clearTimeout(mediaTimer);
  if (mediaProc) { const p = mediaProc; mediaProc = null; try { p.kill(); } catch {} }
}

function startBridge(pairingCode = '') {
  stopBridge();
  if (!fs.existsSync(bridgeEntry)) { state.phase = 'stopped'; state.error = 'Не найдены файлы бриджа. Переустановите программу'; push(); return; }
  state.phase = pairingCode ? 'pairing' : 'starting';
  state.error = '';
  let unpairedSeen = false, reasonNext = false, reason = '';
  let mediaEnv = {};
  if (mediaAvailable()) {
    try {
      mediaSecrets = mediaSecrets || media.ensureMediaSecrets(dataDir());
      mediaEnv = media.bridgeMediaEnv({ secrets: mediaSecrets, dashboardUrl: config.dashboardUrl });
      startMedia();
    } catch (e) { addLog(`живое видео недоступно: ${e.message}`); }
  }
  child = spawn(process.execPath, [bridgeEntry], {
    cwd: path.dirname(bridgeEntry),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SUPABASE_URL: config.supabaseUrl || '',
      SUPABASE_ANON_KEY: config.supabaseAnonKey || '',
      PAIRING_CODE: pairingCode,
      STATE_FILE: stateFile(),
      FFMPEG_PATH: ffmpegPath,
      PLATFORM_URL: config.dashboardUrl || '',
      API_ENABLED: 'true',
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      ...mediaEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const onData = (buf) => {
    const text = buf.toString();
    addLog(text);
    for (const line of text.split(/\r?\n/)) {
      const msg = line.replace(/^\[[^\]]+\]\s*/, '').trim();
      if (reasonNext && msg) { reason = msg; reasonNext = false; }
      if (msg.includes('Бридж не привязан')) { unpairedSeen = true; reasonNext = true; }
    }
    push();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => { addLog(`не удалось запустить бридж: ${e.message}`); });
  const mine = child;
  child.on('exit', (code) => {
    if (child !== mine) return;
    child = null;
    state.online = false; state.health = null;
    if (quitting) return;
    if (unpairedSeen || !isPaired()) {
      state.phase = 'unpaired';
      state.error = pairingCode ? (reason || 'Код не подошёл. Проверьте код и попробуйте снова') : '';
      push();
      return;
    }
    state.phase = 'starting';
    addLog(`бридж остановился (код ${code}), перезапуск через ${Math.round(restartDelay / 1000)} с`);
    push();
    restartTimer = setTimeout(() => startBridge(), restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  push();
}

function stopBridge() {
  clearTimeout(restartTimer);
  if (child) { const c = child; child = null; try { c.kill(); } catch {} }
}

function pollHealth() {
  const req = http.get({ host: '127.0.0.1', port: API_PORT, path: '/health', timeout: 2500 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      try {
        const h = JSON.parse(body);
        state.health = h; state.online = true; restartDelay = 5000;
        if (child) state.phase = h.access && h.access.allowed === false ? 'blocked' : 'running';
      } catch { state.online = false; }
      push();
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => { if (state.online) { state.online = false; push(); } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 700, minWidth: 820, minHeight: 560, show: !process.argv.includes('--hidden'),
    backgroundColor: '#0A1330', title: 'SafeZone Bridge', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => { if (!quitting && !TEST_SHOT) { e.preventDefault(); win.hide(); } });
}

function openDashboard() {
  const url = config.dashboardUrl;
  if (!url) return;
  if (dashWin && !dashWin.isDestroyed()) { dashWin.show(); dashWin.focus(); return; }
  dashWin = new BrowserWindow({ width: 1360, height: 860, title: 'SafeZone', autoHideMenuBar: true, backgroundColor: '#0A1330',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  dashWin.webContents.setUserAgent(`${dashWin.webContents.getUserAgent()} SafeZoneBridge/${app.getVersion()}`);
  dashWin.webContents.setWindowOpenHandler(({ url: u }) => { if (sameOrigin(u, url)) return { action: 'allow' }; openOutside(u); return { action: 'deny' }; });
  dashWin.webContents.on('will-navigate', (e, u) => { if (!sameOrigin(u, url)) { e.preventDefault(); openOutside(u); } });
  dashWin.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMISSIONS.has(perm)));
  dashWin.loadURL(url).catch(() => { addLog('дашборд не открылся: нет связи с облаком'); push(); });
}

function createTray() {
  try {
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR42mNgGAWjgP7gPwMDw38GBob/ROD/xGhmYCAC/CdGMzEu+E+MZmJc8J9UzQMHAACTjw/xo8m0WQAAAABJRU5ErkJggg==');
    tray = new Tray(icon);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть SafeZone Bridge', click: () => { win.show(); win.focus(); } },
      { label: 'Открыть дашборд', click: openDashboard },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { win.show(); win.focus(); });
  } catch (e) { addLog(`значок в области уведомлений недоступен: ${e.message}`); }
}

ipcMain.handle('get-state', () => state);
ipcMain.handle('open-dashboard', () => { openDashboard(); return true; });
ipcMain.handle('pair', (_e, code) => {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(clean)) { state.error = 'Код состоит из 8 букв и цифр'; push(); return false; }
  startBridge(clean);
  return true;
});
ipcMain.handle('unpair', () => {
  stopBridge();
  for (const f of ['state.json', 'access.json']) { try { fs.unlinkSync(path.join(dataDir(), f)); } catch {} }
  state.phase = 'unpaired'; state.error = ''; state.health = null; state.online = false;
  push();
  return true;
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    fs.mkdirSync(dataDir(), { recursive: true });
    createWindow();
    createTray();
    powerSaveBlocker.start('prevent-app-suspension');
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    if (!state.configured) { state.phase = 'stopped'; state.error = 'Программа собрана без адреса платформы. Обратитесь к поставщику'; }
    else if (isPaired()) startBridge();
    else state.phase = 'unpaired';
    pollTimer = setInterval(pollHealth, 3000);
    win.webContents.on('did-finish-load', push);
    if (process.env.SZ_TEST_PAIR) setTimeout(() => startBridge(process.env.SZ_TEST_PAIR), 1200);
    if (TEST_SHOT) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(TEST_SHOT, img.toPNG());
        console.log(`снимок: ${state.phase}`);
        quitting = true; stopBridge(); app.quit();
      }, Number(process.env.SZ_TEST_DELAY || 6000));
    }
  });
  app.on('web-contents-created', (_e, wc) => { wc.on('will-attach-webview', (ev) => ev.preventDefault()); });
  app.on('before-quit', () => { quitting = true; clearInterval(pollTimer); stopBridge(); stopMedia(); });
  app.on('window-all-closed', () => {});
}
