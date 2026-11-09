// Окно приложения для сквозной проверки живого видео: те же настройки, что у окна дашборда.
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-features', 'PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  w.webContents.setUserAgent(`${w.webContents.getUserAgent()} SafeZoneBridge/test`);
  w.loadURL(process.env.E2E_URL);
  setTimeout(() => app.quit(), Number(process.env.E2E_TIMEOUT || 60000));
});
app.on('window-all-closed', () => {});
