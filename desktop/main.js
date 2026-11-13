// 벌툰 채팅 포스용 프로그램
// - 직원 화면(/admin)을 창에 띄우고
// - 손님 메시지가 오면 창을 다른 프로그램(포스) 위로 강제로 올립니다
// - 확인하면 다시 보통 창으로 돌아갑니다
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
let config = { url: '', password: '' };
try { config = Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) {}
function saveConfig() { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

let win = null, tray = null, settingsWin = null, quitting = false;

// 중복 실행 방지 (두 번 켜면 기존 창을 앞으로)
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

// 직원 화면 Basic 인증 자동 처리
app.on('login', (event, webContents, details, authInfo, callback) => {
  if (config.password) { event.preventDefault(); callback('staff', config.password); }
});

function adminUrl() { return config.url.replace(/\/+$/, '') + '/admin'; }

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    title: '벌툰 채팅',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(adminUrl());
  // 닫기 버튼 = 트레이로 숨김 (프로그램은 계속 실행되어 알림을 받음)
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    if (code === -3) return; // 사용자가 중단한 로드
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<body style="font-family:sans-serif;padding:40px;text-align:center"><h2>서버에 연결할 수 없습니다</h2><p>${desc} (${code})</p><p>${config.url}</p><p>인터넷 연결을 확인하거나 트레이 아이콘 → 설정에서 주소를 확인하세요.</p><button onclick="location.href='${adminUrl()}'" style="font-size:18px;padding:10px 24px">다시 시도</button></body>`));
  });
}

// ---------- 맨 위로 올리기 / 내리기 ----------
function bringToFront() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');   // 전체화면 포스 프로그램보다 위
  win.moveTop();
  win.focus();
  win.flashFrame(true);                        // 작업표시줄 깜빡임
  if (process.platform === 'win32') { app.focus({ steal: true }); }
}
function backToNormal() {
  if (!win) return;
  win.setAlwaysOnTop(false);
  win.flashFrame(false);
}
ipcMain.on('bultoon:alert', bringToFront);
ipcMain.on('bultoon:ack', backToNormal);

// ---------- 설정 창 ----------
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({ width: 480, height: 380, title: '벌툰 채팅 설정', resizable: false, autoHideMenuBar: true, parent: win || undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}
ipcMain.handle('settings:get', () => config);
ipcMain.handle('settings:save', (e, data) => {
  config.url = String(data.url || '').trim();
  config.password = String(data.password || '');
  saveConfig();
  if (!win) createWindow(); else win.loadURL(adminUrl());
  if (settingsWin) settingsWin.close();
  return true;
});

// ---------- 트레이 ----------
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('벌툰 채팅');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '설정 (서버 주소/비밀번호)', click: openSettings },
    { label: '알림 테스트 (맨 위로 올리기)', click: () => { bringToFront(); setTimeout(backToNormal, 3000); } },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

app.whenReady().then(() => {
  createTray();
  // 윈도우 로그인 시 자동 실행
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  if (!config.url) openSettings(); else createWindow();
});
app.on('window-all-closed', () => {}); // 트레이에 남아 있어야 하므로 종료하지 않음
app.on('before-quit', () => { quitting = true; });
