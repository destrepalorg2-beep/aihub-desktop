/* voice-tts.js — «голова и уши» Edit в main-процессе.
 *
 * Три вещи:
 *   1) ASR  — распознавание речи через Fish Audio (/v1/asr);
 *   2) TTS  — озвучка ответа через Fish Audio (/v1/tts);
 *   3) ASK  — сам ответ: локальная Ollama (localhost:11434), интернет не нужен.
 *
 * Про ключ. Ключ Fish берётся из userData/voice.json (туда его кладёт поле в
 * настройках Edit). Если там пусто — читаем voice-key.txt рядом с этим файлом:
 * так установщик может прописать ключ заранее, и вводить руками ничего не надо.
 * В сами исходники приложения ключ не вшит — если папку с приложением кому-то
 * отдать, ключ с ней не уедет.
 *
 * Про обрывы. У некоторых провайдеров api.fish.audio режется (ECONNRESET).
 * Поэтому: запрос умеет идти через прокси (системный прокси Windows, который
 * ставит VPN, или заданный вручную) и один раз повторяется при обрыве.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

let electron = null;
try { electron = require('electron'); } catch {}
const app = electron && electron.app;
const ipcMain = electron && electron.ipcMain;

const FISH_HOST = 'api.fish.audio';
const DEFAULT_TTS_MODEL = 's2.1-pro-free';
const DEFAULT_ASR_MODEL = 'transcribe-1';
const OLLAMA = { host: '127.0.0.1', port: 11434 };
const IS_WIN = process.platform === 'win32';

/* ── конфиг ──────────────────────────────────────────────────────────────── */
function dataDir() {
  try { if (app) return app.getPath('userData'); } catch {}
  return path.join(process.env.APPDATA || process.env.HOME || '.', 'OllamaAIDesktop');
}
function cfgPath() { return path.join(dataDir(), 'voice.json'); }
function keyFilePath() { return path.join(__dirname, 'voice-key.txt'); }

/* ── кэш готовых озвучек ─────────────────────────────────────────────────────
 * Один и тот же текст (с тем же голосом) не гоняем через Fish Audio второй
 * раз — берём уже готовый mp3 с диска. Экономит и деньги/кредиты, и время
 * ответа (с диска почти мгновенно, а не 1-2 сек на сеть). */
function ttsCacheDir() {
  const dir = path.join(dataDir(), 'tts-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function ttsCacheKey(text, cfg) {
  const h = crypto.createHash('sha256');
  h.update(String(text || '').trim());
  h.update('|' + (cfg.referenceId || ''));
  h.update('|' + (cfg.model || DEFAULT_TTS_MODEL));
  return h.digest('hex');
}
function ttsCachePath(text, cfg) {
  return path.join(ttsCacheDir(), ttsCacheKey(text, cfg) + '.mp3');
}

function readCfg() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; } catch {}
  if (!cfg.key) {
    // Ключ, положенный установщиком рядом с приложением.
    try {
      const k = fs.readFileSync(keyFilePath(), 'utf8').trim();
      if (k) cfg.key = k;
    } catch {}
  }
  return cfg;
}
function writeCfg(cfg) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/* ── прокси: системный (его ставит VPN) или заданный вручную ─────────────── */
let proxyCache;   // undefined = ещё не смотрели, null = нет прокси
function sysProxy() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve(null);
    const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    execFile('reg', ['query', KEY, '/v', 'ProxyEnable'], (e1, out1) => {
      if (e1 || !/0x1/i.test(out1 || '')) return resolve(null);
      execFile('reg', ['query', KEY, '/v', 'ProxyServer'], (e2, out2) => {
        if (e2 || !out2) return resolve(null);
        const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out2);
        if (!m) return resolve(null);
        let v = m[1].trim();
        // может быть вида "http=host:port;https=host:port"
        const hm = /(?:https?=)?([\w.\-]+:\d+)/.exec(v);
        resolve(hm ? hm[1] : null);
      });
    });
  });
}
async function getProxy() {
  const cfg = readCfg();
  if (cfg.proxy === 'off') return null;
  if (cfg.proxy) return cfg.proxy;
  if (proxyCache === undefined) { try { proxyCache = await sysProxy(); } catch { proxyCache = null; } }
  return proxyCache;
}

/** Соединение до api.fish.audio: напрямую или туннелем CONNECT через прокси. */
function connectTo(hostname, port, proxy) {
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const s = tls.connect({ host: hostname, port, servername: hostname }, () => resolve(s));
      s.once('error', reject);
      return;
    }
    const [ph, pp] = String(proxy).split(':');
    const sock = net.connect({ host: ph, port: Number(pp) || 8080 }, () => {
      sock.write('CONNECT ' + hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + hostname + ':' + port + '\r\n\r\n');
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('binary');
      if (buf.indexOf('\r\n\r\n') === -1) return;
      sock.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) { sock.destroy(); return reject(new Error('прокси отказал: ' + buf.split('\r\n')[0])); }
      const t = tls.connect({ socket: sock, servername: hostname }, () => resolve(t));
      t.once('error', reject);
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
}

/** POST на api.fish.audio с повтором при обрыве соединения. */
async function fishPost(pathname, headers, body, tries) {
  const attempt = async (proxy) => {
    const socket = await connectTo(FISH_HOST, 443, proxy);
    return await new Promise((resolve, reject) => {
      const req = https.request({
        host: FISH_HOST, path: pathname, method: 'POST', headers,
        createConnection: () => socket,
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(40000, () => req.destroy(new Error('таймаут')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };

  const proxy = await getProxy();
  try {
    return await attempt(proxy);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const broken = /ECONNRESET|EPIPE|socket hang up|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(msg);
    if (broken && (tries || 0) < 1) {
      // Рвут напрямую — пробуем через прокси, и наоборот.
      const other = proxy ? null : await sysProxy();
      if (other !== proxy) {
        try { return await attempt(other); } catch (e2) { throw netError(e2); }
      }
      await new Promise((r) => setTimeout(r, 600));
      return fishPost(pathname, headers, body, (tries || 0) + 1);
    }
    throw netError(e);
  }
}
function netError(e) {
  const msg = (e && e.message) || String(e);
  if (/ECONNRESET|EPIPE|socket hang up/i.test(msg)) {
    const err = new Error('соединение с Fish Audio разорвано (похоже, провайдер режет). Включи VPN или укажи прокси в настройках Edit');
    return err;
  }
  if (/ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/i.test(msg)) return new Error('Fish Audio недоступен (' + msg + '). Похоже, заблокирован — включи VPN');
  return e instanceof Error ? e : new Error(msg);
}

/* ── озвучка ─────────────────────────────────────────────────────────────── */
async function synth(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'Пустой текст.' };
  const cfg = readCfg();
  if (!cfg.key) return { ok: false, error: 'no_key' };

  // Уже озвучивали именно этот текст этим же голосом — отдаём готовый файл,
  // к Fish Audio вообще не обращаемся.
  const cachePath = ttsCachePath(t, cfg);
  try {
    const cached = fs.readFileSync(cachePath);
    if (cached && cached.length) return { ok: true, audio: cached.toString('base64'), cached: true };
  } catch {}

  const body = Buffer.from(JSON.stringify({
    text: t, format: 'mp3', mp3_bitrate: 128, normalize: true,
    ...(cfg.referenceId ? { reference_id: cfg.referenceId } : {}),
  }), 'utf8');

  const outHeaders = {
    'Authorization': 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'model': cfg.model || DEFAULT_TTS_MODEL,
  };
  // Диагностика: печатаем что реально уходит в запрос (ключ маскируем,
  // но видно длину и первые/последние символы — этого достаточно, чтобы
  // понять, не "потерялся" ли он и какой именно ключ сейчас используется).
  try {
    const k = cfg.key || '';
    const masked = k.length > 12 ? (k.slice(0, 10) + '...' + k.slice(-4)) : '(пусто)';
    console.log('[fish-tts] запрос → model=%s referenceId=%s key=%s (длина %d) Authorization длина=%d',
      outHeaders.model, cfg.referenceId || '(нет)', masked, k.length, outHeaders.Authorization.length);
  } catch {}

  try {
    const r = await fishPost('/v1/tts', outHeaders, body);
    if (r.status !== 200) {
      let msg = 'код ' + r.status;
      try { const j = JSON.parse(r.body.toString('utf8')); if (j && j.message) msg = j.message; } catch {}
      return { ok: false, error: (r.status === 401 || r.status === 403) ? 'bad_key' : msg };
    }
    if (!r.body.length) return { ok: false, error: 'пустой ответ озвучки' };
    try { fs.writeFileSync(cachePath, r.body); } catch {}
    return { ok: true, audio: r.body.toString('base64') };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

/* ── распознавание ───────────────────────────────────────────────────────── */
function multipart(fields, fileField, fileName, fileType, buf) {
  const b = '----FishBoundary' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const k in fields) {
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n', 'utf8'));
  }
  parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + fileField + '"; filename="' + fileName + '"\r\nContent-Type: ' + fileType + '\r\n\r\n', 'utf8'));
  parts.push(buf);
  parts.push(Buffer.from('\r\n--' + b + '--\r\n', 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + b };
}

async function asr(audioB64, mime) {
  const cfg = readCfg();
  if (!cfg.key) return { ok: false, error: 'no_key' };
  let buf;
  try { buf = Buffer.from(String(audioB64 || ''), 'base64'); } catch { return { ok: false, error: 'плохая запись' }; }
  if (!buf || !buf.length) return { ok: false, error: 'пустая запись' };

  const type = String(mime || 'audio/webm').split(';')[0];
  const ext = type.indexOf('ogg') >= 0 ? 'ogg' : (type.indexOf('mp4') >= 0 ? 'mp4' : (type.indexOf('wav') >= 0 ? 'wav' : 'webm'));
  const mp = multipart({ language: 'ru', ignore_timestamps: 'true' }, 'audio', 'speech.' + ext, type, buf);

  try {
    const r = await fishPost('/v1/asr', {
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': mp.contentType,
      'Content-Length': mp.body.length,
      'model': cfg.asrModel || DEFAULT_ASR_MODEL,
    }, mp.body);
    const raw = r.body.toString('utf8');
    if (r.status !== 200) {
      let msg = 'код ' + r.status;
      try { const j = JSON.parse(raw); if (j && j.message) msg = j.message; } catch {}
      return { ok: false, error: (r.status === 401 || r.status === 403) ? 'bad_key' : msg };
    }
    let j; try { j = JSON.parse(raw); } catch { return { ok: false, error: 'не разобрал ответ' }; }
    const text = String((j && j.text) || '').replace(/<\|[^|]*\|>/g, '').trim();
    if (!text) return { ok: false, error: 'ничего не расслышал' };
    return { ok: true, text };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

/* ── мозг: локальная Ollama ──────────────────────────────────────────────── */
function localJson(pathname, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const req = http.request({
      host: OLLAMA.host, port: OLLAMA.port, path: pathname, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
    }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Ollama: код ' + res.statusCode));
        try { resolve(JSON.parse(d)); } catch { reject(new Error('Ollama: не разобрал ответ')); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Ollama не ответила (таймаут)')));
    req.on('error', () => reject(new Error('Ollama не запущена (localhost:11434)')));
    if (body) req.write(body);
    req.end();
  });
}

// Какую модель брать, если в Ollama их несколько. Qwen впереди: он умнее
// и его память разговора занимает вчетверо меньше видеопамяти, чем у phi3.
const MODEL_RANK = [/^qwen3-edit/i, /^qwen3/i, /qwen/i, /llama/i, /mistral/i, /gemma/i];

async function pickModel() {
  const cfg = readCfg();
  if (cfg.llm) return cfg.llm;
  const tags = await localJson('/api/tags', 'GET');
  const list = ((tags && tags.models) || []).map((m) => m && m.name).filter(Boolean);
  if (!list.length) throw new Error('в Ollama нет моделей — скачай: ollama pull qwen3:8b');
  for (const rx of MODEL_RANK) {
    const hit = list.find((n) => rx.test(n));
    if (hit) return hit;
  }
  return list[0];
}

// Qwen3 умеет «думать вслух» и возвращать размышления в <think>…</think>.
// Зачитывать их голосом нельзя — вырезаем.
function stripThinking(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

// Два режима: голосом (коротко, без разметки) и текстом в AI-чате приложения
// (можно развёрнуто, со списками и кодом).
const SYSTEM_PROMPT =
  'Ты — Edit, голосовой помощник на компьютере пользователя. Отвечай по-русски, ' +
  'коротко и по делу: 1-3 предложения, без списков и без разметки, потому что ответ ' +
  'будет зачитан вслух. Не рассуждай вслух и не описывай ход своих мыслей — ' +
  'сразу давай готовый ответ. Помни предыдущие реплики разговора. ' +
  'У тебя есть доступ к компьютеру пользователя через действия: ' +
  'open (открыть сайт/папку/файл/приложение), type (напечатать текст в активное окно), ' +
  'move (передвинуть курсор мыши в точку экрана x,y), click (кликнуть мышью, можно с x,y, ' +
  'button "left" или "right"), run (выполнить команду в консоли — единственное действие, ' +
  'которое пользователь подтверждает вручную, остальные выполняются сразу). ' +
  'Ничего не удаляй и не меняй системные настройки без явной просьбы. ' +
  'Когда для ответа на просьбу нужно одно из этих действий — не выполняй его сама, ' +
  'а верни ОДНОЙ строкой в самом конце ответа: ' +
  'ACTION_JSON: {"type":"open|type|move|click|run","arg":"...","x":0,"y":0,"button":"left","say":"короткая фраза для пользователя"} ' +
  '("arg" обязателен для open/type/run; для move/click вместо него используй x и y). ' +
  '"say" — то, что ты скажешь вслух, объясняя, что делаешь (например "Открываю ютуб"). ' +
  'Если действие не нужно — просто отвечай текстом, без ACTION_JSON.';

const CHAT_PROMPT =
  'Ты — AI-ассистент внутри приложения AI Server Hub. Отвечай по-русски, по делу ' +
  'и по существу. Можно развёрнуто, со списками, командами и кодом, если это ' +
  'уместно. Не описывай ход своих мыслей — сразу давай готовый ответ. ' +
  'Помни предыдущие реплики разговора.';

// think:false понимают не все версии Ollama и не все модели — если ругнётся,
// повторяем запрос без этого поля.
async function chatOnce(model, msgs, withThinkFlag) {
  const payload = { model, messages: msgs, stream: false };
  if (withThinkFlag) payload.think = false;
  return localJson('/api/chat', 'POST', payload);
}

async function ask(text, history, mode) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'пустой вопрос' };
  try {
    const model = await pickModel();
    let sys = mode === 'chat' ? CHAT_PROMPT : SYSTEM_PROMPT;
    if (/qwen3/i.test(model)) sys += ' /no_think';
    const msgs = [{ role: 'system', content: sys }];
    // Edit присылает историю как {role,text}, AI-чат приложения — как {role,content}.
    (history || []).forEach((m) => {
      const c = m && (m.text || m.content);
      if (c) msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(c) });
    });
    // последняя реплика уже может быть в истории — не дублируем
    if (!msgs.length || msgs[msgs.length - 1].content !== t) msgs.push({ role: 'user', content: t });

    let r;
    try { r = await chatOnce(model, msgs, true); }
    catch (e) { r = await chatOnce(model, msgs, false); }

    const out = stripThinking((r && r.message && r.message.content) || '');
    if (!out) return { ok: false, error: 'модель вернула пустой ответ' };
    return { ok: true, text: out, model };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

/* ── IPC ─────────────────────────────────────────────────────────────────── */
function register() {
  if (!ipcMain) { console.error('[Edit] ipcMain недоступен — голос не подключён'); return; }
  ipcMain.handle('voice:tts', (_e, text) => synth(text));
  ipcMain.handle('voice:asr', (_e, o) => asr(o && o.audio, o && o.mime));
  ipcMain.handle('voice:ask', (_e, o) => ask(o && o.text, o && o.history, o && o.mode));
  // Лёгкая проверка «жива ли локальная модель» — для индикатора в AI-чате.
  ipcMain.handle('voice:llm', async () => {
    try { return { ok: true, model: await pickModel() }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  });
  ipcMain.handle('voice:has-key', () => {
    const c = readCfg();
    return {
      hasKey: !!c.key, model: c.model || DEFAULT_TTS_MODEL,
      referenceId: c.referenceId || '', proxy: c.proxy || '', llm: c.llm || '',
    };
  });
  ipcMain.handle('voice:set-key', (_e, key) => {
    const k = String(key || '').trim();
    const cfg = readCfg();
    if (!k) { delete cfg.key; writeCfg(cfg); return { ok: true, hasKey: false }; }
    cfg.key = k;
    return writeCfg(cfg) ? { ok: true, hasKey: true } : { ok: false, error: 'Не смог сохранить ключ.' };
  });
  ipcMain.handle('voice:set-voice', (_e, referenceId) => {
    const cfg = readCfg();
    const r = String(referenceId || '').trim();
    if (r) cfg.referenceId = r; else delete cfg.referenceId;
    return writeCfg(cfg) ? { ok: true } : { ok: false, error: 'Не смог сохранить голос.' };
  });
  ipcMain.handle('voice:set-proxy', (_e, proxy) => {
    const cfg = readCfg();
    const p = String(proxy || '').trim();
    if (p) cfg.proxy = p; else delete cfg.proxy;
    proxyCache = undefined;
    return writeCfg(cfg) ? { ok: true } : { ok: false, error: 'Не смог сохранить прокси.' };
  });
  // Диагностика: что живо, а что нет.
  ipcMain.handle('voice:check', async () => {
    const out = { key: !!readCfg().key, proxy: await getProxy(), fish: null, ollama: null };
    try {
      const r = await synth('проверка связи');
      out.fish = r.ok ? 'ok' : r.error;
    } catch (e) { out.fish = (e && e.message) || String(e); }
    try {
      const m = await pickModel();
      out.ollama = 'ok (' + m + ')';
    } catch (e) { out.ollama = (e && e.message) || String(e); }
    return out;
  });
}

/* Ключ, положенный установщиком рядом с приложением, при первом запуске
   переезжает в userData/voice.json, а файл удаляется — чтобы ключ не остался
   валяться в папке приложения и не уехал, если папку кому-то отдать. */
function importKeyFile() {
  try {
    const p = keyFilePath();
    if (!fs.existsSync(p)) return;
    const k = fs.readFileSync(p, 'utf8').trim();
    if (!k) { try { fs.unlinkSync(p); } catch {} return; }
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; } catch {}
    if (!cfg.key) { cfg.key = k; writeCfg(cfg); }
    try { fs.unlinkSync(p); } catch {}
    console.log('[Edit] ключ озвучки перенесён в настройки приложения');
  } catch {}
}

importKeyFile();
register();

module.exports = { synth, asr, ask, multipart, readCfg, writeCfg, cfgPath, keyFilePath, importKeyFile };
