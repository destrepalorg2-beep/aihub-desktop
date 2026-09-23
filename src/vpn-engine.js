/* vpn-engine.js — реальный запуск VPN в main-процессе Electron.
 *
 * Это тот слой, которого не хватало кнопке: она звала window.vpnConnect, а он
 * жил здесь. Схема как у Happ/Shadowrocket в режиме «системный прокси»:
 *   выбранный сервер → конфиг Xray (vpn-core.js) → запускаем xray.exe →
 *   он поднимает локальные SOCKS/HTTP входы → включаем системный прокси Windows
 *   на эти входы → весь трафик идёт через сервер. Без прав администратора и без
 *   драйверов (TUN — отдельный, более тяжёлый режим, будет позже).
 *
 * Движок (xray.exe) не входит в приложение. Он ищется локально, а если нет —
 * скачивается с официального GitHub с проверкой SHA-256. Если GitHub закрыт
 * провайдером, пользователь кладёт xray.exe в папку движка вручную — приложение
 * показывает какую.
 *
 * Живёт в main-процессе НАМЕРЕННО: только отсюда можно гарантированно вернуть
 * системный прокси в исходное состояние при выходе из приложения — иначе, если
 * бы прокси ставил renderer, закрытие приложения в подключённом состоянии могло
 * бы оставить систему без интернета.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { spawn, exec, execFile } = require('child_process');

let electron = null;
try { electron = require('electron'); } catch {}
const app = electron && electron.app;
const ipcMain = electron && electron.ipcMain;
const shell = electron && electron.shell;
const BrowserWindow = electron && electron.BrowserWindow;

/* Разбор ссылок и сборка конфига — общий с интерфейсом файл. В Node он кладёт
   себя в module.exports (см. низ vpn-core.js). */
let VpnCore = null;
try { VpnCore = require(path.join(__dirname, 'renderer', 'vpn-core.js')); } catch (e) {
  try { VpnCore = require('./renderer/vpn-core.js'); } catch (e2) {
    console.error('[VPN] vpn-core.js не загружен:', e2 && e2.message);
  }
}

const IS_WIN = process.platform === 'win32';
const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;
const GH_API = 'https://api.github.com/repos/XTLS/Xray-core/releases/latest';
const REG_INET = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/* ── пути ────────────────────────────────────────────────────────────────── */
function dataDir() {
  try { if (app) return app.getPath('userData'); } catch {}
  return path.join(process.env.APPDATA || process.env.HOME || '.', 'OllamaAIDesktop');
}
function engineDir() { return path.join(dataDir(), 'engine'); }
function enginePath() { return path.join(engineDir(), IS_WIN ? 'xray.exe' : 'xray'); }
function configPath() { return path.join(engineDir(), 'config.json'); }

/* Ищем движок в нескольких привычных местах, а не только в userData — чтобы
   пользователь мог просто бросить xray.exe рядом. Возвращаем путь или null. */
function resolveEngine() {
  const bin = IS_WIN ? 'xray.exe' : 'xray';
  const spots = [enginePath()];
  try { spots.push(path.join(process.resourcesPath || '', 'engine', bin)); } catch {}
  try { if (app) spots.push(path.join(path.dirname(app.getPath('exe')), 'engine', bin)); } catch {}
  try {
    const home = (app && app.getPath('home')) || process.env.HOME || process.env.USERPROFILE || '';
    if (home) { spots.push(path.join(home, 'Desktop', 'xray', bin)); spots.push(path.join(home, 'Desktop', bin)); }
  } catch {}
  for (const p of spots) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  return null;
}

/* ── состояние ───────────────────────────────────────────────────────────── */
let state = 'off';          // off | connecting | on
let proc = null;            // процесс xray
let currentNode = null;
let currentMode = 'proxy';
let logLines = [];          // последние строки движка — для диагностики
let savedProxy = null;      // прежние настройки системного прокси (для отката)

function pushLog(s) {
  String(s).split(/\r?\n/).forEach((l) => { if (l.trim()) logLines.push(l.trim()); });
  if (logLines.length > 200) logLines = logLines.slice(-200);
}
function lastLog() { return logLines.slice(-12).join('\n'); }

function broadcast(extra) {
  const payload = Object.assign({ state, mode: currentMode, node: currentNode && currentNode.name }, extra || {});
  try {
    if (BrowserWindow) BrowserWindow.getAllWindows().forEach((w) => { try { w.webContents.send('vpn-state', payload); } catch {} });
  } catch {}
}
function setState(s, extra) { state = s; broadcast(extra); }

/* ── конфиг Xray для выбранного сервера ──────────────────────────────────── */
function buildXrayConfig(node) {
  if (!VpnCore || typeof VpnCore.buildConfig !== 'function') return null;
  return VpnCore.buildConfig(node, { socksPort: SOCKS_PORT, httpPort: HTTP_PORT });
}

/* ── запуск/остановка процесса движка ────────────────────────────────────── */
function spawnXray(bin, cfg) {
  logLines = [];
  proc = spawn(bin, ['run', '-config', cfg], { windowsHide: true });
  proc.stdout && proc.stdout.on('data', (d) => pushLog(d.toString()));
  proc.stderr && proc.stderr.on('data', (d) => pushLog(d.toString()));
  proc.on('error', (err) => { pushLog('spawn error: ' + err.message); });
  proc.on('exit', (code) => {
    pushLog('движок завершился, код ' + code);
    proc = null;
    // Тоннель упал сам по себе — снимаем прокси, чтобы не остаться без сети.
    if (state === 'on' || state === 'connecting') {
      restoreProxy().finally(() => setState('off', { error: 'Движок остановился (код ' + code + ')' }));
    }
  });
}
function killXray() {
  if (!proc) return;
  const p = proc; proc = null;
  try {
    if (IS_WIN && p.pid) exec(`taskkill /pid ${p.pid} /T /F`);
    else p.kill();
  } catch {}
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 9000);
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
      s.on('error', () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tryOnce, 250); });
      s.setTimeout(1200, () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tryOnce, 250); });
    };
    tryOnce();
  });
}

/* ── системный прокси Windows (реестр + мгновенное применение) ────────────── */
function regQuery(valueName) {
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_INET, '/v', valueName], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // строка вида:  ProxyEnable    REG_DWORD    0x1
      const m = new RegExp(valueName + '\\s+REG_\\w+\\s+(.+)', 'i').exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}
function regSet(valueName, type, data) {
  return new Promise((resolve) => {
    execFile('reg', ['add', REG_INET, '/v', valueName, '/t', type, '/d', String(data), '/f'], () => resolve());
  });
}
/* Мгновенно сообщить системе и браузерам, что настройки прокси изменились. */
function refreshWinInet() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve();
    const ps = "$s='[DllImport(\"wininet.dll\")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);';"
      + "$t=Add-Type -MemberDefinition $s -Name Wi -Namespace Ap -PassThru;"
      + "$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null;"
      + "$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null;";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], () => resolve());
  });
}

async function setSystemProxy(on) {
  if (!IS_WIN) { pushLog('системный прокси доступен только на Windows'); return; }
  if (on) {
    // Запоминаем прежнее состояние ровно один раз, чтобы корректно откатиться.
    if (!savedProxy) {
      savedProxy = {
        enable: await regQuery('ProxyEnable'),
        server: await regQuery('ProxyServer'),
        override: await regQuery('ProxyOverride'),
      };
    }
    await regSet('ProxyServer', 'REG_SZ', '127.0.0.1:' + HTTP_PORT);
    await regSet('ProxyOverride', 'REG_SZ', 'localhost;127.*;10.*;172.16.*;192.168.*;<local>');
    await regSet('ProxyEnable', 'REG_DWORD', 1);
    await refreshWinInet();
  } else {
    await restoreProxy();
  }
}

async function restoreProxy() {
  if (!IS_WIN) return;
  try {
    if (savedProxy) {
      // Возврат к тому, что было до подключения.
      const prevEnable = /0x1/i.test(savedProxy.enable || '') ? 1 : 0;
      await regSet('ProxyEnable', 'REG_DWORD', prevEnable);
      if (savedProxy.server && !/^\s*$/.test(savedProxy.server)) await regSet('ProxyServer', 'REG_SZ', savedProxy.server);
      if (savedProxy.override && !/^\s*$/.test(savedProxy.override)) await regSet('ProxyOverride', 'REG_SZ', savedProxy.override);
    } else {
      // Не знали прежнего — просто выключаем прокси.
      await regSet('ProxyEnable', 'REG_DWORD', 0);
    }
    await refreshWinInet();
  } catch (e) { pushLog('откат прокси: ' + (e && e.message)); }
  savedProxy = null;
}

/* ── подключение / отключение ────────────────────────────────────────────── */
async function connect(node, mode) {
  if (state === 'on' || state === 'connecting') return { ok: false, error: 'Уже подключается или подключено.' };
  if (!node || !node.host) return { ok: false, error: 'Сначала выберите сервер.' };
  currentNode = node; currentMode = mode || 'proxy';

  const engine = resolveEngine();
  if (!engine) return { ok: false, error: 'Движок Xray не найден.', needEngine: true, engineDir: engineDir() };

  const cfg = buildXrayConfig(node);
  if (!cfg) return { ok: false, error: 'Этот протокол пока не поддерживается движком.' };

  setState('connecting');
  try {
    fs.mkdirSync(engineDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    spawnXray(engine, configPath());

    const up = await waitForPort(HTTP_PORT, 9000);
    if (!up) { killXray(); setState('off'); return { ok: false, error: 'Движок не поднял локальный порт. Проверьте сервер/подписку.', log: lastLog() }; }

    // TUN пока не реализован — не молчим, а честно включаем системный прокси.
    const note = currentMode === 'tun' ? 'Режим TUN пока недоступен — включён системный прокси.' : '';
    await setSystemProxy(true);

    setState('on', { note });
    return { ok: true, mode: 'proxy', note };
  } catch (e) {
    try { killXray(); } catch {}
    try { await restoreProxy(); } catch {}
    setState('off');
    return { ok: false, error: 'Ошибка запуска: ' + (e && e.message ? e.message : e), log: lastLog() };
  }
}

async function disconnect() {
  killXray();
  await restoreProxy();
  setState('off');
  return { ok: true };
}

/* ── скачивание движка с официального GitHub (с проверкой SHA-256) ────────── */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'AIHub-VPN/1' }, headers || {}) }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(httpsGet(res.headers.location, headers));
      }
      let data = ''; res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
  });
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u, redirects) => {
      const req = https.get(u, { headers: { 'User-Agent': 'AIHub-VPN/1' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume(); return go(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      });
      req.setTimeout(60000, () => req.destroy(new Error('таймаут загрузки')));
      req.on('error', reject);
    };
    go(url, 0);
  });
}
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function downloadEngine() {
  if (!IS_WIN) return { ok: false, error: 'Автозагрузка движка сделана для Windows. На другой ОС положите бинарник xray в папку движка.' };
  try {
    fs.mkdirSync(engineDir(), { recursive: true });
    const rel = await httpsGet(GH_API, { Accept: 'application/vnd.github+json' });
    if (rel.status !== 200) return { ok: false, error: 'GitHub недоступен (код ' + rel.status + '). Возможно, провайдер блокирует его — положите xray.exe вручную.', needEngine: true, engineDir: engineDir() };
    let info; try { info = JSON.parse(rel.body); } catch { return { ok: false, error: 'Не разобрал ответ GitHub.' }; }
    const asset = (info.assets || []).find((a) => /Xray-windows-64\.zip$/i.test(a.name));
    if (!asset) return { ok: false, error: 'В релизе нет сборки для Windows.' };
    const expected = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();

    const zipPath = path.join(engineDir(), 'xray-download.zip');
    await download(asset.browser_download_url, zipPath);

    const got = (await sha256(zipPath)).toLowerCase();
    if (expected && got !== expected) {
      try { fs.unlinkSync(zipPath); } catch {}
      return { ok: false, error: 'Контрольная сумма не совпала — файл повреждён или подменён. Загрузка отменена.' };
    }

    // Распаковка через штатный PowerShell (без сторонних библиотек).
    await new Promise((resolve, reject) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${engineDir()}' -Force`], (err) => err ? reject(err) : resolve());
    });
    try { fs.unlinkSync(zipPath); } catch {}

    if (!fs.existsSync(enginePath())) return { ok: false, error: 'После распаковки не нашёл xray.exe.' };
    return { ok: true, version: info.tag_name || '', sha256: got, path: enginePath() };
  } catch (e) {
    return { ok: false, error: 'Не удалось скачать движок: ' + (e && e.message ? e.message : e) + '. Можно положить xray.exe вручную.', needEngine: true, engineDir: engineDir() };
  }
}

/* ── IPC: то, что зовёт интерфейс ────────────────────────────────────────── */
function register() {
  if (!ipcMain) { console.error('[VPN] ipcMain недоступен — движок не подключён'); return; }
  ipcMain.handle('vpn:connect', (_e, opts) => connect(opts && opts.node, opts && opts.mode));
  ipcMain.handle('vpn:disconnect', () => disconnect());
  ipcMain.handle('vpn:status', () => ({ state, mode: currentMode, node: currentNode && currentNode.name, engine: resolveEngine(), log: lastLog() }));
  ipcMain.handle('vpn:engine-info', () => ({ found: !!resolveEngine(), path: resolveEngine(), dir: engineDir() }));
  ipcMain.handle('vpn:download-engine', () => downloadEngine());
  ipcMain.handle('vpn:open-engine-dir', () => { try { fs.mkdirSync(engineDir(), { recursive: true }); if (shell) shell.openPath(engineDir()); } catch {} return engineDir(); });

  // При выходе из приложения обязательно вернуть системный прокси на место.
  try {
    if (app) app.on('before-quit', () => { killXray(); if (IS_WIN && savedProxy) { try { execFile('reg', ['add', REG_INET, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', /0x1/i.test(savedProxy.enable || '') ? '1' : '0', '/f']); } catch {} } });
  } catch {}

  // Самоочистка при старте: если прошлый сеанс упал аварийно и оставил системный
  // прокси на НАШ порт — движок сейчас точно не запущен, значит прокси «мёртвый»
  // и без этого пользователь остался бы без интернета. Аккуратно выключаем.
  if (IS_WIN) {
    regQuery('ProxyServer').then((srv) => {
      if (srv && srv.indexOf('127.0.0.1:' + HTTP_PORT) !== -1) {
        regSet('ProxyEnable', 'REG_DWORD', 0).then(refreshWinInet);
        pushLog('startup: снят зависший прокси от прошлого сеанса');
      }
    }).catch(() => {});
  }
}

register();

module.exports = { connect, disconnect, downloadEngine, resolveEngine, buildXrayConfig, engineDir, enginePath };
