const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');

// VPN-движок (реальное подключение: запуск xray + системный прокси). Модуль сам
// регистрирует свои IPC-обработчики и откат прокси при выходе. Обёрнут в try,
// чтобы любая проблема с движком не помешала запуску самого приложения.
try { require('./vpn-engine'); } catch (e) { console.error('[VPN] движок не загружен:', e && e.message); }

/* Security: block in-app navigation to remote pages (which would run with Node
   access) and route any window.open to the user's real browser. */
function hardenWindow(win) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); try { shell.openExternal(url); } catch {} }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:/i.test(url)) { try { shell.openExternal(url); } catch {} }
    return { action: 'deny' };
  });
}

// ── Globals ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let adminWindow = null;
let settingsWindow = null;
let tray = null;
const SERVER_BASE_URL = 'http://localhost:3000';
let serverProcess = null;
let isServerRunning = false;

// ── App settings ─────────────────────────────────────────────────────────────
app.setName('AI Server Hub');

// ── Create main window ────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 380,
    minHeight: 600,
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    backgroundMaterial: 'acrylic',
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    skipTaskbar: false,
    title: 'AI Server Hub',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  hardenWindow(mainWindow);

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Dev tools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── Create admin window (ГЛАВНОЕ ОКНО) ────────────────────────────────────────
function createAdminWindow() {
  if (adminWindow) {
    adminWindow.show();
    adminWindow.focus();
    return;
  }

  adminWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    center: true,
    show: true,
    backgroundColor: '#111118',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    title: 'AI Server — Admin Panel',
  });

  adminWindow.loadFile(path.join(__dirname, 'renderer/admin.html'));
  hardenWindow(adminWindow);

  // Force the window to the front once it can paint
  adminWindow.once('ready-to-show', () => {
    adminWindow.show();
    adminWindow.center();
    adminWindow.setAlwaysOnTop(true);
    adminWindow.focus();
    setTimeout(() => { if (adminWindow) adminWindow.setAlwaysOnTop(false); }, 3000);
  });

  adminWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Window] admin.html failed to load:', code, desc);
  });

  adminWindow.on('close', (e) => {
    e.preventDefault();
    adminWindow.hide(); // Скрываем в трей вместо закрытия
  });

  adminWindow.on('closed', () => {
    adminWindow = null;
  });
}

// ── Create settings window ────────────────────────────────────────────────────
function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 620,
    frame: false,
    transparent: true,
    backgroundMaterial: 'acrylic',
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Settings',
    parent: mainWindow,
    show: false,
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer/settings.html'));
  hardenWindow(settingsWindow);

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.error('[Tray] icon load failed:', e.message);
    try {
      // Fallback: 1x1 transparent pixel (createEmpty() throws on Windows)
      const img = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo4B0AAAFQAABbXpMzAAAAABJRU5ErkJggg=='
      );
      tray = new Tray(img);
    } catch (e2) {
      console.error('[Tray] disabled:', e2.message);
      tray = null;
      return; // App keeps running without a tray icon
    }
  }

  tray.setToolTip('AI Server Hub');
  updateTrayMenu();

  tray.on('click', () => {
    if (adminWindow) {
      adminWindow.isVisible() ? adminWindow.hide() : adminWindow.show();
    } else {
      createAdminWindow();
    }
  });

  tray.on('double-click', () => {
    if (adminWindow) {
      adminWindow.show();
      adminWindow.focus();
    } else {
      createAdminWindow();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'AI Server Hub',
      enabled: false,
      icon: null,
    },
    { type: 'separator' },
    {
      label: isServerRunning ? '🟢 Сервер запущен' : '🔴 Сервер остановлен',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Показать Admin Panel',
      click: () => {
        if (adminWindow) { adminWindow.show(); adminWindow.focus(); }
        else createAdminWindow();
      },
    },
    { type: 'separator' },
    {
      label: isServerRunning ? 'Остановить сервер' : 'Запустить сервер',
      click: toggleServer,
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        app.exit(0);
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// ── Server control ────────────────────────────────────────────────────────────
async function toggleServer() {
  if (isServerRunning) {
    stopServer();
  } else {
    startServer();
  }
}

function startServer() {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const serverPath = path.join(__dirname, '../../dist/index.js');

  if (!fs.existsSync(serverPath)) {
    console.error('[Server] dist/index.js not found at', serverPath, '- run "npm run build" first');
    showNotification('Сервер не найден', 'dist/index.js отсутствует. Выполните npm run build.');
    return;
  }

  // spawn, not exec: exec buffers stdout (default 1 MB) and kills a long-running
  // server once the buffer fills. detached+taskkill also lets us stop it reliably.
  serverProcess = spawn('node', [serverPath], {
    cwd: path.join(__dirname, '../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (d) => console.log('[Server]', d.toString().trim()));
  serverProcess.stderr.on('data', (d) => console.error('[Server]', d.toString().trim()));
  serverProcess.on('error', (err) => console.error('[Server] spawn failed:', err.message));
  serverProcess.on('exit', (code) => {
    console.log('[Server] exited with code', code);
    serverProcess = null;
    isServerRunning = false;
    updateTrayMenu();
    broadcastServerStatus();
  });

  // Poll until server is up
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    checkServerHealth().then((alive) => {
      if (alive) {
        clearInterval(poll);
        isServerRunning = true;
        updateTrayMenu();
        broadcastServerStatus();
        showNotification('Сервер запущен', 'Ollama AI Server готов к работе');
      }
    });
    if (attempts > 20) clearInterval(poll);
  }, 500);
}

function stopServer() {
  if (serverProcess) {
    // On Windows, kill() does not reap the child tree — use taskkill.
    if (process.platform === 'win32' && serverProcess.pid) {
      exec(`taskkill /pid ${serverProcess.pid} /T /F`);
    } else {
      serverProcess.kill();
    }
    serverProcess = null;
  }
  isServerRunning = false;
  updateTrayMenu();
  broadcastServerStatus();
  showNotification('Сервер остановлен', 'Ollama AI Server остановлен');
}

function broadcastServerStatus() {
  if (mainWindow) mainWindow.webContents.send('server-status', { running: isServerRunning });
  if (adminWindow) adminWindow.webContents.send('server-status', { running: isServerRunning });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function checkServerHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_BASE_URL}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function fetchApi(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${SERVER_BASE_URL}${endpoint}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** POST helper for the same local server — used to share one real account
 * between this app and the website: both talk to the same localhost:3000. */
async function postApi(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request(
      `${SERVER_BASE_URL}${endpoint}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let d = '';
        res.on('data', (chunk) => { d += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Notifications ─────────────────────────────────────────────────────────────
function showNotification(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const iconPath = path.join(__dirname, '../assets/icon.png');
    const opts = { title, body };
    if (require('fs').existsSync(iconPath)) opts.icon = iconPath;
    new Notification(opts).show();
  } catch (e) {
    console.error('[Notification] failed:', e.message);
  }
}

// ── Auto-start (Windows Registry) ────────────────────────────────────────────
function setAutoStart(enable) {
  if (process.platform !== 'win32') return;
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const appPath = `"${process.execPath}"`;
  if (enable) {
    exec(`reg add "${regKey}" /v "OllamaAIDesktop" /t REG_SZ /d ${appPath} /f`);
  } else {
    exec(`reg delete "${regKey}" /v "OllamaAIDesktop" /f`);
  }
}

function getAutoStartEnabled() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(false); return; }
    exec('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v OllamaAIDesktop',
      (err) => resolve(!err)
    );
  });
}

// ── Local admin account ───────────────────────────────────────────────────────
// There is no accounts backend, so the admin credential lives on this machine.
// Only a PBKDF2 hash is stored — never the password itself.
const crypto = require('crypto');
const fs = require('fs');

const AUTH_FILE = () => path.join(app.getPath('userData'), 'auth.json');

function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf8')); }
  catch { return null; }
}

function writeAuth(data) {
  fs.mkdirSync(path.dirname(AUTH_FILE()), { recursive: true });
  fs.writeFileSync(AUTH_FILE(), JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256').toString('hex');
}

/* Constant-time compare so a wrong password cannot be timed character by character. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

ipcMain.handle('auth-status', () => {
  const a = readAuth();
  return { registered: !!(a && a.hash), email: a?.email, synced: !!(a && a.synced) };
});

// Registration/login are shared with the website: both talk to the same
// local server (localhost:3000, the same one whose /health this file already
// polls), so an account made here is the same account the site knows about,
// and vice versa. If the server isn't running yet, we fall back to a
// local-only account on this machine so first-run setup still works — it
// gets synced to the server automatically next time login succeeds online.
ipcMain.handle('auth-register', async (_e, email, password) => {
  const existing = readAuth();
  // First account on this machine becomes the OWNER (admin). If an owner
  // already exists, a new registration is treated as a regular user account.
  if (existing && existing.hash) {
    return { ok: true, role: 'user' };
  }
  if (!email || !password) return { ok: false, code: 'empty_fields' };
  if (String(password).length < 8) return { ok: false, code: 'too_short' };
  const normalizedEmail = String(email).trim().toLowerCase();
  const nickname = normalizedEmail.split('@')[0] || 'admin';

  let synced = false;
  try {
    const r = await postApi('/api/auth/register', { email: normalizedEmail, password, nickname });
    // 201 = created just now; 409 = this email already has a real account
    // (e.g. registered on the site first) — either way the server now has
    // (or already had) this email+password pair, so login will find it.
    synced = r.status === 201 || r.status === 409;
  } catch (e) {
    console.log('[Auth] server not reachable during register, staying local-only:', e.message);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  writeAuth({
    email: normalizedEmail,
    salt,
    hash: hashPassword(password, salt),
    role: 'admin',
    synced,
    createdAt: new Date().toISOString(),
  });
  return { ok: true, role: 'admin', synced };
});

// Real credential check. Tries the shared server account first (same one the
// website uses); if the server can't be reached, or this email/password only
// ever existed on this machine, falls back to the local record. Both paths
// check the password for real — no bypass.
ipcMain.handle('auth-login', async (_e, email, password) => {
  const entered = String(email || '').trim().toLowerCase();
  const pass = String(password || '');

  try {
    const r = await postApi('/api/auth/login', { email: entered, password: pass });
    if (r.status === 200 && r.body && r.body.token) {
      // Cache locally so the app still recognizes this account when the
      // server isn't running (e.g. next cold start before it's spawned).
      const salt = crypto.randomBytes(16).toString('hex');
      writeAuth({
        email: entered,
        salt,
        hash: hashPassword(pass, salt),
        role: 'admin',
        synced: true,
        token: r.body.token,
        nickname: r.body.nickname,
        createdAt: (readAuth() || {}).createdAt || new Date().toISOString(),
      });
      return { ok: true, email: entered, role: 'admin', synced: true };
    }
    if (r.status === 401) {
      // Server has this email under a different password — that's a real,
      // final answer, no point falling back to the (now stale) local copy.
      return { ok: false, code: 'invalid_credentials' };
    }
    // Any other server response (500, unexpected shape, no account there
    // yet): fall through to the local check below.
  } catch (e) {
    console.log('[Auth] server not reachable during login, checking local copy:', e.message);
  }

  const a = readAuth();
  if (!a || !a.hash) return { ok: false, code: 'not_registered' };
  const emailOk = safeEqual(entered, a.email);
  const passOk = safeEqual(hashPassword(pass, a.salt), a.hash);
  if (!emailOk || !passOk) return { ok: false, code: 'invalid_credentials' };
  return { ok: true, email: entered, role: a.role || 'admin', synced: !!a.synced };
});

ipcMain.handle('auth-file', () => AUTH_FILE());

ipcMain.handle('auth-reset', () => {
  try { fs.unlinkSync(AUTH_FILE()); } catch {}
  return { ok: true };
});

// ── Project folder access (for the AI agent) ───────────────────────────────────
// Opens a native directory picker anchored to the requesting window and returns
// the chosen absolute path (or null if cancelled).
ipcMain.handle('pick-directory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Открыть папку проекта',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-server-status', async () => {
  const alive = await checkServerHealth();
  isServerRunning = alive;
  updateTrayMenu();
  return { running: alive };
});

ipcMain.handle('toggle-server', async () => {
  await toggleServer();
  return { running: isServerRunning };
});

ipcMain.handle('fetch-api', async (_, endpoint) => {
  try { return await fetchApi(endpoint); }
  catch { return null; }
});

ipcMain.handle('open-admin', () => {
  createAdminWindow();
});

ipcMain.handle('open-settings', () => {
  createSettingsWindow();
});

// Window controls.
// Renderers use two naming conventions: admin-renderer.js calls
// `window-<action>` while older code calls `<action>-window`. Register BOTH
// names for each action so no title-bar button can end up without a handler.
function winMinimize(event) {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
}

function winMaximize(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
}

function winClose(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  // Only the admin window hides to tray; other windows just close.
  // (Previously this called app.quit(), so closing Settings killed the app.)
  if (win === adminWindow) win.hide();
  else win.close();
}

for (const [action, fn] of [['minimize', winMinimize], ['maximize', winMaximize], ['close', winClose]]) {
  ipcMain.handle(`${action}-window`, fn);
  ipcMain.handle(`window-${action}`, fn);
}

ipcMain.handle('get-auto-start', async () => {
  return await getAutoStartEnabled();
});

ipcMain.handle('set-auto-start', (_, enable) => {
  setAutoStart(enable);
});

ipcMain.handle('get-network-info', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
});

// ── Claude Bridge ─────────────────────────────────────────────────────────────
let claudeBridgeProcess = null;

ipcMain.on('start-claude-bridge', (event) => {
  if (claudeBridgeProcess && !claudeBridgeProcess.killed) {
    event.sender.send('claude-bridge-status', { running: true, message: 'Уже запущен' });
    return;
  }

  const { spawn } = require('child_process');
  const fs = require('fs');
  // Look next to the project first, fall back to the old hardcoded location.
  const candidates = [
    path.join(__dirname, '../../claude_bridge.py'),
    path.join(app.getPath('home'), 'Desktop', 'Claude_Hub', 'claude_bridge.py'),
  ];
  const bridgePath = candidates.find((p) => fs.existsSync(p));

  if (!bridgePath) {
    event.sender.send('claude-bridge-status', {
      running: false,
      message: 'claude_bridge.py не найден',
    });
    return;
  }

  claudeBridgeProcess = spawn('python', [bridgePath], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  claudeBridgeProcess.stdout.on('data', (data) => {
    console.log('[Claude Bridge]', data.toString());
  });

  claudeBridgeProcess.stderr.on('data', (data) => {
    console.error('[Claude Bridge ERR]', data.toString());
  });

  claudeBridgeProcess.on('close', (code) => {
    console.log('[Claude Bridge] exited with code', code);
    claudeBridgeProcess = null;
  });

  claudeBridgeProcess.on('error', (err) => {
    console.error('[Claude Bridge] failed to start:', err.message);
    event.sender.send('claude-bridge-status', { running: false, message: err.message });
    claudeBridgeProcess = null;
  });

  // Give it 1 second then report success
  setTimeout(() => {
    if (claudeBridgeProcess && !claudeBridgeProcess.killed) {
      event.sender.send('claude-bridge-status', { running: true, message: 'claude_bridge.py запущен' });
    }
  }, 1000);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
// Never let an unexpected error kill the app silently
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});

app.whenReady().then(async () => {
  // Сразу открываем Admin Panel — главное окно не нужно
  createAdminWindow();
  try {
    createTray();
  } catch (e) {
    console.error('[Tray] skipped:', e.message);
  }

  // Check if server is already running
  const alive = await checkServerHealth();
  isServerRunning = alive;
  updateTrayMenu();

  // Poll server status every 5 seconds
  setInterval(async () => {
    const prev = isServerRunning;
    isServerRunning = await checkServerHealth();
    if (prev !== isServerRunning) {
      updateTrayMenu();
      broadcastServerStatus();
    }
  }, 5000);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createAdminWindow();
  }
  adminWindow?.show();
});

// Keep running in the tray. On Windows/Linux Electron quits by default here,
// so we simply do not call app.quit() (preventDefault has no effect on this event).
app.on('window-all-closed', () => {});

// Make sure the spawned server does not outlive the app.
app.on('before-quit', () => {
  if (serverProcess && process.platform === 'win32' && serverProcess.pid) {
    exec(`taskkill /pid ${serverProcess.pid} /T /F`);
  } else if (serverProcess) {
    serverProcess.kill();
  }
  if (claudeBridgeProcess && !claudeBridgeProcess.killed) claudeBridgeProcess.kill();
});

app.on('before-quit', () => {
  if (adminWindow) adminWindow.removeAllListeners('close');
});

// ---- Edit (voice assistant): added by installer ----
try { require('./pc-agent'); } catch (e) { console.error('[PC] not loaded:', e && e.message); }
try { require('./voice-tts'); } catch (e) { console.error('[TTS] not loaded:', e && e.message); }
