/* pc-agent.js — «руки» голосового ассистента на ПК (main-процесс Electron).
 *
 * Ассистент в интерфейсе распознаёт речь и решает, что сделать. Сами действия
 * на компьютере выполняются ЗДЕСЬ, в main-процессе. Каждое действие приходит
 * только после того, как пользователь подтвердил его в окне («Выполнить?») —
 * подтверждение живёт в интерфейсе, а сюда действие доходит уже одобренным.
 *
 * Возможности v1 (сознательно узкие и безопасные):
 *   • open  — открыть сайт, папку, файл или приложение;
 *   • type  — напечатать текст в активное окно (как с клавиатуры);
 *   • run   — выполнить команду в оболочке и вернуть результат.
 * Ничего не удаляем и не трогаем системные настройки — это не входит в v1.
 *
 * Живёт в main-процессе намеренно: у renderer нет прямого и безопасного способа
 * запускать процессы и открывать произвольные цели, а тут это уже есть (как у
 * сервера и VPN-движка).
 */
'use strict';

const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');

let electron = null;
try { electron = require('electron'); } catch {}
const ipcMain = electron && electron.ipcMain;
const shell = electron && electron.shell;

const IS_WIN = process.platform === 'win32';

/* ── открыть цель: сайт / папка / файл / приложение ──────────────────────── */
async function openTarget(target) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, error: 'Не указано, что открыть.' };
  try {
    if (/^https?:\/\//i.test(t)) { if (shell) await shell.openExternal(t); return { ok: true, kind: 'url', target: t }; }
    // Похоже на домен без схемы (example.com) — откроем как сайт.
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) && !fs.existsSync(t)) {
      if (shell) await shell.openExternal('https://' + t); return { ok: true, kind: 'url', target: 'https://' + t };
    }
    if (fs.existsSync(t)) { if (shell) { const err = await shell.openPath(t); if (err) return { ok: false, error: err }; } return { ok: true, kind: 'path', target: t }; }
    // Иначе считаем это именем приложения.
    if (IS_WIN) {
      // start "" "app" — резолвит и системные приложения (notepad, calc, chrome…)
      exec(`start "" "${t.replace(/"/g, '')}"`, { windowsHide: true });
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [t], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, kind: 'app', target: t };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ── напечатать текст в активное окно ────────────────────────────────────── */
function typeText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve({ ok: false, error: 'Пустой текст.' });
  if (!IS_WIN) return Promise.resolve({ ok: false, error: 'Печать текста пока сделана для Windows.' });
  // SendKeys: спецсимволы +^%~(){}[] имеют особый смысл — экранируем в {…}.
  const esc = s.replace(/([+^%~(){}\[\]])/g, '{$1}').replace(/\r?\n/g, '{ENTER}');
  const ps = "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(@'\n" + esc + "\n'@)";
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

/* ── мышь: движение и клик ───────────────────────────────────────────────────
 * Без нативных npm-модулей (robotjs/nut.js) — им на Windows нужен компилятор
 * (Visual Studio Build Tools), которого может не быть. Вместо этого — то же,
 * что и с клавиатурой: короткий PowerShell-скрипт с Add-Type на user32.dll.
 * Работает из коробки на любой Windows, ничего ставить не нужно. */
const MOUSE_PS_TYPE =
  "Add-Type @'\n" +
  "using System;\n" +
  "using System.Runtime.InteropServices;\n" +
  "public class VAMouse {\n" +
  "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);\n" +
  "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);\n" +
  "}\n" +
  "'@\n";
const MOUSE_LEFT_DOWN = 0x0002, MOUSE_LEFT_UP = 0x0004, MOUSE_RIGHT_DOWN = 0x0008, MOUSE_RIGHT_UP = 0x0010;

function runPs(ps) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

/** Передвинуть курсор в точку экрана (пиксели, левый верхний угол = 0,0). */
function moveMouse(x, y) {
  const xi = Math.round(Number(x)), yi = Math.round(Number(y));
  if (!IS_WIN) return Promise.resolve({ ok: false, error: 'Управление мышью пока сделано для Windows.' });
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return Promise.resolve({ ok: false, error: 'Нужны числа x и y.' });
  return runPs(MOUSE_PS_TYPE + `[VAMouse]::SetCursorPos(${xi}, ${yi})`);
}

/** Клик в точке экрана (по умолчанию левой кнопкой; можно 'right'; можно с переносом курсора). */
function clickMouse(x, y, button) {
  if (!IS_WIN) return Promise.resolve({ ok: false, error: 'Управление мышью пока сделано для Windows.' });
  const right = String(button || 'left').toLowerCase() === 'right';
  const down = right ? MOUSE_RIGHT_DOWN : MOUSE_LEFT_DOWN;
  const up = right ? MOUSE_RIGHT_UP : MOUSE_LEFT_UP;
  let move = '';
  const xi = Math.round(Number(x)), yi = Math.round(Number(y));
  if (Number.isFinite(xi) && Number.isFinite(yi)) move = `[VAMouse]::SetCursorPos(${xi}, ${yi});`;
  const ps = MOUSE_PS_TYPE + move +
    `[VAMouse]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero);` +
    `Start-Sleep -Milliseconds 40;` +
    `[VAMouse]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`;
  return runPs(ps);
}

/* ── выполнить команду в оболочке ────────────────────────────────────────── */
function runCommand(command) {
  const c = String(command || '').trim();
  if (!c) return Promise.resolve({ ok: false, error: 'Пустая команда.' });
  return new Promise((resolve) => {
    exec(c, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = ((stdout || '') + (stderr || '')).trim().slice(0, 4000);
      if (err && !out) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, output: out || '(команда выполнена, вывода нет)' });
    });
  });
}

function register() {
  if (!ipcMain) { console.error('[PC] ipcMain недоступен — действия на ПК не подключены'); return; }
  ipcMain.handle('pc:open', (_e, target) => openTarget(target));
  ipcMain.handle('pc:type', (_e, text) => typeText(text));
  ipcMain.handle('pc:run', (_e, command) => runCommand(command));
  ipcMain.handle('pc:mouseMove', (_e, p) => moveMouse(p && p.x, p && p.y));
  ipcMain.handle('pc:click', (_e, p) => clickMouse(p && p.x, p && p.y, p && p.button));
}

register();

module.exports = { openTarget, typeText, runCommand, moveMouse, clickMouse };
