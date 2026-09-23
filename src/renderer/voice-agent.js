/* voice-agent.js — голосовой ассистент («edit») в интерфейсе.
 *
 * Ты жмёшь кнопку (или горячую клавишу), говоришь — браузерное распознавание
 * речи переводит голос в текст, ассистент решает, что делать, и отвечает
 * ГОЛОСОМ (синтез речи). Умеет две вещи:
 *   • команды на ПК — «открой…», «напечатай…», «выполни команду…» — каждая
 *     выполняется только после подтверждения в окне; сами действия делает
 *     main-процесс (pc-agent.js);
 *   • вопросы — уходят в твою модель (AI-чат приложения) и ответ озвучивается.
 *
 * И слух, и голос — через Fish Audio (один ключ): звук с микрофона пишется в
 * самом окне и уходит на распознавание, ответ приходит готовым mp3. Встроенное
 * распознавание Chromium тут не годится — внутри Electron оно падает с ошибкой
 * «network» (ходит на серверы Google по ключу, которого в Electron нет).
 */
'use strict';

(function () {
  const LS_VOICE = 'va.voiceReply';   // озвучивать ответы (1/0)
  const LS_HIST = 'va.history';       // вся переписка — помнится между запусками
  const HIST_MAX = 500;               // сколько реплик храним
  const HIST_FOR_MODEL = 200;         // сколько последних отдаём модели как память

  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  // ipcRenderer — для действий на ПК (в Electron); в тестах — стуб.
  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch {}
  if (!ipc && typeof window !== 'undefined' && window.__ipcStub) ipc = window.__ipcStub;

  /* ── состояние ───────────────────────────────────────────────────────────── */
  let media = null;         // MediaRecorder — запись с микрофона
  let micStream = null;     // сам поток микрофона (чтобы выключить лампочку)
  let chunks = [];          // куски записи
  let mode = 'idle';        // idle | listening | thinking | speaking
  // ── автостоп по тишине (VAD) ───────────────────────────────────────────
  // Не ждём второго нажатия: слушаем громкость микрофона, и как только
  // после речи наступает достаточная тишина — сами останавливаем запись
  // и отправляем, как будто ты нажал ещё раз.
  let vadCtx = null, vadAnalyser = null, vadRaf = null, vadSilenceSince = 0, vadHeardSpeech = false, vadStartAt = 0;
  const VAD_SPEECH_LEVEL = 0.02;     // порог громкости, после которого считаем, что ты говоришь
  const VAD_SILENCE_MS = 1400;       // сколько тишины подряд ждём, прежде чем считать фразу оконченной
  const VAD_MAX_MS = 60000;          // страховка: не пишем дольше минуты, даже если VAD не сработал
  let messages = loadHistory();  // [{role:'user'|'assistant'|'system', text, at}]
  let voiceReply = lsGet(LS_VOICE, '1') === '1';
  let ttsKey = { hasKey: false };   // есть ли ключ озвучки (сам ключ сюда не приходит)
  let keyNotice = '';               // подсказка про ключ, если озвучка не прошла
  let showSettings = false;
  let wantFocus = false;            // вернуть курсор в поле ввода после ответа
  let audioEl = null;               // проигрываемый ответ (чтобы можно было прервать)

  /* ── распознавание речи ──────────────────────────────────────────────────────
   * Встроенное распознавание Chromium (webkitSpeechRecognition) внутри Electron
   * не работает — падает с ошибкой "network", потому что ходит на серверы Google
   * по ключу, которого в Electron нет. Поэтому пишем звук сами и отправляем на
   * распознавание Fish Audio (main-процесс, тот же ключ, что и для озвучки).
   *
   * Логика простая: нажал — пишем, нажал ещё раз (или пробел) — отправляем.
   */
  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const m of list) {
      try { if (window.MediaRecorder && window.MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return '';
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const step = 0x8000; // по кускам — иначе стек переполнится на длинной записи
    for (let i = 0; i < bytes.length; i += step) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(s);
  }

  async function startListening() {
    if (mode === 'listening') { stopListening(); return; }
    if (mode === 'thinking') return;
    if (mode === 'speaking') stopSpeaking();

    if (!ipc) { pushMsg('system', 'Распознавание работает только внутри приложения.'); render(); return; }
    if (!ttsKey.hasKey) {
      pushMsg('system', 'Для распознавания речи нужен ключ Fish Audio — вставь его в Настройках ниже.');
      showSettings = true; render(); return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      pushMsg('system', 'Нет доступа к микрофону: ' + ((e && e.message) || e) +
        '. Проверь в Windows: Параметры → Конфиденциальность → Микрофон.');
      render(); return;
    }

    const mime = pickMime();
    try {
      media = mime ? new window.MediaRecorder(micStream, { mimeType: mime }) : new window.MediaRecorder(micStream);
    } catch (e) {
      stopMic();
      pushMsg('system', 'Не смог включить запись: ' + ((e && e.message) || e)); render(); return;
    }

    chunks = [];
    media.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    media.onstop = onRecordingStop;
    try { media.start(); } catch (e) { stopMic(); pushMsg('system', 'Запись не началась: ' + ((e && e.message) || e)); render(); return; }

    startVad(micStream);
    mode = 'listening'; render();
  }

  function stopListening() {
    // Дальше всё делает onstop — там и отправка на распознавание.
    stopVad();
    try { if (media && media.state !== 'inactive') media.stop(); else { mode = 'idle'; render(); } }
    catch { mode = 'idle'; render(); }
  }

  function stopMic() {
    stopVad();
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch {}
    micStream = null; media = null;
  }

  /** Следим за громкостью микрофона: как только после речи наступает
   * достаточная тишина — сами останавливаем запись (эквивалент второго
   * нажатия), не дожидаясь ручного стопа. */
  function startVad(stream) {
    stopVad();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // нет Web Audio — просто останется ручной стоп
      vadCtx = new AC();
      const src = vadCtx.createMediaStreamSource(stream);
      vadAnalyser = vadCtx.createAnalyser();
      vadAnalyser.fftSize = 512;
      src.connect(vadAnalyser);
      const buf = new Uint8Array(vadAnalyser.fftSize);
      vadHeardSpeech = false;
      vadSilenceSince = 0;
      vadStartAt = Date.now();
      const tick = () => {
        if (!vadAnalyser) return; // остановили
        vadAnalyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms >= VAD_SPEECH_LEVEL) {
          vadHeardSpeech = true;
          vadSilenceSince = 0;
        } else if (vadHeardSpeech) {
          if (!vadSilenceSince) vadSilenceSince = now;
          else if (now - vadSilenceSince >= VAD_SILENCE_MS) { stopListening(); return; }
        }
        if (now - vadStartAt >= VAD_MAX_MS) { stopListening(); return; } // страховка от бесконечной записи
        vadRaf = requestAnimationFrame(tick);
      };
      vadRaf = requestAnimationFrame(tick);
    } catch { /* без VAD — работает старый ручной стоп */ }
  }
  function stopVad() {
    if (vadRaf) { try { cancelAnimationFrame(vadRaf); } catch {} vadRaf = null; }
    vadAnalyser = null;
    if (vadCtx) { try { vadCtx.close(); } catch {} vadCtx = null; }
  }

  async function onRecordingStop() {
    const type = (media && media.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type });
    chunks = [];
    stopMic();

    if (!blob.size) { mode = 'idle'; render(); return; }

    mode = 'thinking'; render();

    let b64;
    try { b64 = bufToBase64(await blob.arrayBuffer()); }
    catch (e) { mode = 'idle'; pushMsg('system', 'Не смог прочитать запись.'); render(); return; }

    let r = null;
    try { r = await ipc.invoke('voice:asr', { audio: b64, mime: type }); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }

    if (r && r.ok && r.text) { handleUtterance(r.text); return; }

    mode = 'idle';
    const err = (r && r.error) || 'пусто';
    if (err === 'bad_key') pushMsg('system', 'Ключ Fish Audio не подошёл — проверь его в Настройках.');
    else if (err === 'no_key') pushMsg('system', 'Нет ключа Fish Audio — вставь его в Настройках.');
    else pushMsg('system', 'Не расслышал: ' + err);
    render();
  }

  /* ── озвучка ответа ──────────────────────────────────────────────────────────
   * Сначала пробуем живой голос Fish Audio (запрос уходит из main-процесса,
   * ключ туда вписан один раз и в окне не живёт). Если ключа нет или сервис
   * недоступен — не молчим, а озвучиваем встроенным синтезом Windows. */
  async function speak(text) {
    if (!voiceReply || !text) return;
    stopSpeaking();
    if (ipc) {
      try {
        const r = await ipc.invoke('voice:tts', text);
        if (r && r.ok && r.audio) { playAudio(r.audio); return; }
        if (r && r.error === 'bad_key') { keyNotice = 'Ключ озвучки не подошёл — проверь его в настройках.'; render(); }
        else if (r && r.error && r.error !== 'no_key') { keyNotice = 'Озвучка Fish недоступна (' + r.error + ') — говорю встроенным голосом.'; render(); }
      } catch { /* падаем во встроенный синтез */ }
    }
    speakBuiltin(text);
  }

  function playAudio(b64) {
    try {
      audioEl = new Audio('data:audio/mp3;base64,' + b64);
      audioEl.onplay = () => { mode = 'speaking'; render(); };
      audioEl.onended = () => { audioEl = null; if (mode === 'speaking') { mode = 'idle'; render(); } };
      audioEl.onerror = () => { audioEl = null; if (mode === 'speaking') { mode = 'idle'; render(); } };
      audioEl.play().catch(() => { audioEl = null; });
    } catch { audioEl = null; }
  }

  function speakBuiltin(text) {
    try {
      const synth = window.speechSynthesis; if (!synth) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      const ru = (synth.getVoices() || []).find((v) => /ru/i.test(v.lang));
      if (ru) u.voice = ru;
      u.onstart = () => { mode = 'speaking'; render(); };
      u.onend = () => { if (mode === 'speaking') { mode = 'idle'; render(); } };
      synth.speak(u);
    } catch {}
  }

  function stopSpeaking() {
    try { if (audioEl) { audioEl.pause(); audioEl = null; } } catch {}
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    if (mode === 'speaking') mode = 'idle';
  }

  /* ── разбор команды на ПК ────────────────────────────────────────────────── */
  const OPEN_ALIASES = {
    'ютуб': 'https://youtube.com', 'youtube': 'https://youtube.com', 'юутуб': 'https://youtube.com',
    'гугл': 'https://google.com', 'google': 'https://google.com', 'гугл хром': 'chrome', 'хром': 'chrome',
    'почт': 'https://mail.google.com', 'телеграм': 'https://web.telegram.org', 'телеграмм': 'https://web.telegram.org',
    'ютюб': 'https://youtube.com', 'блокнот': 'notepad', 'калькулятор': 'calc', 'проводник': 'explorer',
    'настройки': 'ms-settings:', 'диспетчер задач': 'taskmgr',
  };
  function resolveOpen(arg) {
    const a = String(arg || '').trim().replace(/[.。!?]+$/, '');
    const low = a.toLowerCase();
    if (OPEN_ALIASES[low]) return OPEN_ALIASES[low];
    for (const k in OPEN_ALIASES) if (low === k || low.startsWith(k + ' ')) return OPEN_ALIASES[k];
    return a;
  }
  function parseCommand(text) {
    const t = String(text || '').trim();
    let m;
    if ((m = /^(?:открой|открыть|запусти|запустить|включи)\s+(.+)/i.exec(t))) {
      const target = resolveOpen(m[1]);
      return { type: 'open', arg: target, human: 'Открыть: ' + target };
    }
    if ((m = /^(?:напечатай|набери|напиши|введи)\s+(.+)/i.exec(t))) {
      return { type: 'type', arg: m[1], human: 'Напечатать: “' + m[1] + '”' };
    }
    if ((m = /^(?:выполни команду|выполнить команду|команда|выполни)\s+(.+)/i.exec(t))) {
      return { type: 'run', arg: m[1], human: 'Выполнить команду: ' + m[1] };
    }
    return null;
  }

  /* ── действие, о котором попросила сама модель (ACTION_JSON: {...}) ─────── */
  function parseModelAction(answer) {
    const m = /ACTION_JSON:\s*(\{[\s\S]*\})\s*$/.exec(String(answer || '').trim());
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[1]); } catch { return null; }
    if (!obj || !['open', 'type', 'move', 'click', 'run'].includes(obj.type)) return null;
    if (['open', 'type', 'run'].includes(obj.type) && !obj.arg) return null;
    const say = String(obj.say || '').trim();
    const x = Number(obj.x), y = Number(obj.y), button = obj.button === 'right' ? 'right' : 'left';
    const humanByType = {
      open: 'Открыть: ' + obj.arg,
      type: 'Напечатать: “' + obj.arg + '”',
      move: 'Передвинуть курсор в (' + x + ', ' + y + ')',
      click: 'Клик (' + button + ') в (' + x + ', ' + y + ')',
      run: 'Выполнить команду: ' + obj.arg,
    };
    return { type: obj.type, arg: obj.arg ? String(obj.arg) : '', x, y, button, human: humanByType[obj.type], say };
  }

  // Действия, которые модель может выполнять сразу, без ручного подтверждения:
  // открыть, напечатать, подвигать/кликнуть мышью. Единственное исключение —
  // выполнение произвольной консольной команды (run) — оно может что-то
  // сломать или удалить, поэтому по-прежнему требует подтверждения в окне.
  const AUTO_ACTION_TYPES = new Set(['open', 'type', 'move', 'click']);

  /* ── главный обработчик реплики ──────────────────────────────────────────── */
  async function handleUtterance(text) {
    pushMsg('user', text);
    const cmd = parseCommand(text);
    // Показываем расслышанную фразу сразу, не дожидаясь выполнения.
    if (cmd) {
      mode = 'idle'; render();
      if (AUTO_ACTION_TYPES.has(cmd.type)) await runAndReport(cmd);
      else confirmAction(cmd);
      return;
    }
    // Не команда по шаблону — спрашиваем модель. Она сама может попросить
    // выполнить действие на ПК (ACTION_JSON в конце ответа, см. SYSTEM_PROMPT).
    mode = 'thinking'; render();
    let answer;
    try { answer = await askModel(text); }
    catch (e) { answer = 'Не получилось спросить модель: ' + ((e && e.message) || e); }
    mode = 'idle';

    const modelCmd = parseModelAction(answer);
    if (modelCmd) {
      const spoken = modelCmd.say || (AUTO_ACTION_TYPES.has(modelCmd.type) ? '' : 'Нужно подтверждение действия на компьютере.');
      if (spoken) { pushMsg('assistant', spoken); render(); speak(spoken); }
      if (AUTO_ACTION_TYPES.has(modelCmd.type)) await runAndReport(modelCmd);
      else confirmAction(modelCmd);
      return;
    }

    pushMsg('assistant', answer);
    render();
    speak(answer);
  }

  /** Выполнить действие сразу (без окна подтверждения) и коротко отчитаться. */
  async function runAndReport(cmd) {
    const res = await runAction(cmd);
    if (!res.ok) {
      const line = 'Не вышло (' + cmd.human + '): ' + (res.error || 'ошибка');
      pushMsg('assistant', line); render(); speak('Не получилось.');
    }
    // Успех — не спамим отдельным сообщением в чат, действие уже видно по эффекту
    // (открылось окно, курсор передвинулся и т.п.); "say" модели уже озвучен выше.
  }

  // «Мозг»: думает через модель приложения. Основной путь — общий хук
  // window.__voiceBrain(text) (его вешает AI-чат приложения). Пока хук не
  // подключён — честно говорим об этом (команды на ПК работают и без модели).
  // «Мозг»: отвечает твоя локальная Ollama (localhost:11434) — интернет не нужен.
  // Вторым аргументом уходит память, поэтому модель видит и старые реплики.
  // Qwen3 может вернуть свои размышления в <think>…</think> — вслух их не читаем.
  function stripThinking(s) {
    return String(s || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim();
  }

  async function askModel(text) {
    if (typeof window.__voiceBrain === 'function') {
      const r = await window.__voiceBrain(text, historyForModel());
      return (typeof r === 'string' ? r : (r && r.text)) || 'Пустой ответ модели.';
    }
    if (ipc) {
      const r = await ipc.invoke('voice:ask', { text, history: historyForModel() });
      if (r && r.ok && r.text) return r.text;
      return 'Не смог спросить модель: ' + ((r && r.error) || 'неизвестно');
    }
    return 'Модель доступна только внутри приложения.';
  }

  /* ── подтверждение действия на ПК ────────────────────────────────────────── */
  function confirmAction(cmd) {
    if ($('vaConfirmOverlay')) return;
    const el = document.createElement('div');
    el.id = 'vaConfirmOverlay'; el.className = 'vc-overlay';
    el.innerHTML = `
      <div class="vc-card">
        <div class="vc-card-head"><h3>Подтверди действие</h3><button class="vc-x" id="vaCX" aria-label="Закрыть">✕</button></div>
        <p class="vc-hint">Ассистент хочет выполнить на твоём ПК:</p>
        <div class="va-cmd">${esc(cmd.human)}</div>
        <div class="vc-msg" id="vaCMsg"></div>
        <div class="vc-card-foot"><button class="btn" id="vaCNo">Отмена</button><button class="btn btn-primary" id="vaCYes">Выполнить</button></div>
      </div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    $('vaCX').onclick = $('vaCNo').onclick = () => { close(); pushMsg('assistant', 'Отменил.'); render(); };
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    $('vaCYes').onclick = async () => {
      const y = $('vaCYes'); y.disabled = true; y.textContent = 'Выполняю…';
      const res = await runAction(cmd);
      close();
      const line = res.ok
        ? (res.output ? 'Готово. ' + res.output : 'Готово.')
        : 'Не вышло: ' + (res.error || 'ошибка');
      pushMsg('assistant', line); render(); speak(res.ok ? 'Готово' : 'Не получилось');
    };
  }
  async function runAction(cmd) {
    if (!ipc) return { ok: false, error: 'Действия на ПК доступны только в приложении.' };
    try {
      if (cmd.type === 'open') return await ipc.invoke('pc:open', cmd.arg);
      if (cmd.type === 'type') return await ipc.invoke('pc:type', cmd.arg);
      if (cmd.type === 'run') return await ipc.invoke('pc:run', cmd.arg);
      if (cmd.type === 'move') return await ipc.invoke('pc:mouseMove', { x: cmd.x, y: cmd.y });
      if (cmd.type === 'click') return await ipc.invoke('pc:click', { x: cmd.x, y: cmd.y, button: cmd.button });
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    return { ok: false, error: 'Неизвестное действие.' };
  }

  /* ── журнал сообщений (память) ───────────────────────────────────────────────
   * Всё сказанное — и твоё, и ответы Edit — пишется на диск и переживает
   * перезапуск приложения. При каждом вопросе модели отдаётся кусок этой
   * истории, поэтому она помнит и старое, и новое. */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(LS_HIST);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(LS_HIST, JSON.stringify(messages.slice(-HIST_MAX))); } catch {}
  }
  function pushMsg(role, text) {
    messages.push({ role, text, at: Date.now() });
    if (messages.length > HIST_MAX) messages = messages.slice(-HIST_MAX);
    saveHistory();
  }
  /** Память для модели: последние реплики без служебных сообщений. */
  function historyForModel() {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-HIST_FOR_MODEL)
      .map((m) => ({ role: m.role, text: m.text }));
  }
  window.__voiceHistory = historyForModel;

  /* ── отрисовка ───────────────────────────────────────────────────────────── */
  const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/></svg>';
  function statusText() {
    if (mode === 'listening') return 'Слушаю… договоришь — отправлю сама';
    if (mode === 'thinking') return 'Распознаю…';
    if (mode === 'speaking') return 'Отвечаю…';
    return 'Нажми и говори';
  }
  function bubbles() {
    if (!messages.length) return `<div class="vc-empty">Скажи что-нибудь: «открой ютуб», «напечатай привет», «выполни команду dir» — или задай вопрос.</div>`;
    return messages.map((m) => `<div class="va-row va-${m.role}"><div class="va-bubble">${esc(m.text)}</div></div>`).join('');
  }
  function render() {
    const host = $('view-voice');
    if (!host) return;
    host.innerHTML = `
      <div class="va-wrap">
        <button class="vc-power va-mic ${mode}" id="vaMic" title="Говорить (пробел)">${MIC}</button>
        <div class="vc-status">${statusText()}</div>
        <div class="va-controls">
          <label class="va-toggle"><input type="checkbox" id="vaVoice"${voiceReply ? ' checked' : ''}> Озвучивать ответы</label>
          <button class="btn btn-ghost va-clear" id="vaCfg">Настройки</button>
          <button class="btn btn-ghost va-clear" id="vaClear">Очистить память</button>
        </div>
        ${keyNotice ? `<div class="va-notice">${esc(keyNotice)}</div>` : ''}
        ${showSettings ? `
        <div class="va-settings">
          <div class="va-set-row">
            <label>Ключ озвучки (Fish Audio)</label>
            <input type="password" id="vaKey" class="pf-in" placeholder="${ttsKey.hasKey ? '•••••••• ключ сохранён' : 'вставь ключ сюда'}" autocomplete="new-password" data-user-typed="0">
          </div>
          <div class="va-set-row">
            <label>ID голоса (необязательно)</label>
            <input type="text" id="vaVoiceId" class="pf-in" placeholder="reference_id из кабинета Fish Audio" value="${esc(ttsKey.referenceId || '')}" autocomplete="off">
          </div>
          <div class="va-set-row">
            <label>Прокси для Fish Audio (если провайдер блокирует)</label>
            <input type="text" id="vaProxy" class="pf-in" placeholder="например 127.0.0.1:10809 — пусто = системный/VPN" value="${esc(ttsKey.proxy || '')}" autocomplete="off">
          </div>
          <div class="va-set-hint">Ключ хранится только на этом компьютере, в код не попадает.</div>
          <div class="va-set-foot">
            <button class="btn btn-ghost" id="vaCheck">Проверить связь</button>
            ${ttsKey.hasKey ? '<button class="btn btn-ghost" id="vaKeyDel">Удалить ключ</button>' : ''}
            <button class="btn btn-primary" id="vaKeySave">Сохранить</button>
          </div>
          <div class="vc-msg" id="vaKeyMsg"></div>
        </div>` : ''}
        <div class="va-log" id="vaLog">${bubbles()}</div>
        <div class="va-input">
          <input type="text" id="vaText" class="pf-in" placeholder="Или напиши здесь и нажми Enter…" autocomplete="off">
          <button class="btn btn-primary" id="vaSend">Отправить</button>
        </div>
      </div>`;
    const mic = $('vaMic'); if (mic) mic.onclick = startListening;
    const ti = $('vaText'), sb = $('vaSend');
    const sendText = () => {
      const v = (ti && ti.value || '').trim();
      if (!v) return;
      ti.value = '';
      wantFocus = true;      // после ответа курсор вернётся в поле
      handleUtterance(v);
    };
    if (sb) sb.onclick = sendText;
    if (ti) ti.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } };
    if (ti && wantFocus) { try { ti.focus(); } catch {} }
    const vt = $('vaVoice'); if (vt) vt.onchange = () => { voiceReply = vt.checked; lsSet(LS_VOICE, voiceReply ? '1' : '0'); if (!voiceReply) stopSpeaking(); };
    const cfg = $('vaCfg'); if (cfg) cfg.onclick = () => { showSettings = !showSettings; keyNotice = ''; render(); };
    const cl = $('vaClear'); if (cl) cl.onclick = () => {
      messages = []; saveHistory(); render();
    };
    const save = $('vaKeySave'); if (save) save.onclick = saveVoiceSettings;
    // Защита от автозаполнения: Chromium может незаметно подставить в это
    // поле старый ключ из своего менеджера паролей, даже с autocomplete
    // выставленным. Считаем ключ «реальным» только если пользователь сам
    // что-то напечатал руками (реальное событие клавиатуры), иначе при
    // сохранении поле игнорируем, чтобы не затереть свежий ключ старым.
    const vk = $('vaKey'); if (vk) vk.addEventListener('keydown', () => { vk.dataset.userTyped = '1'; });
    const chk = $('vaCheck'); if (chk) chk.onclick = async () => {
      const m = $('vaKeyMsg');
      chk.disabled = true; chk.textContent = 'Проверяю…';
      if (m) { m.className = 'vc-msg'; m.textContent = 'Проверяю Fish Audio и Ollama…'; }
      let r = null;
      try { r = ipc ? await ipc.invoke('voice:check') : null; } catch (e) { r = { error: String(e && e.message || e) }; }
      chk.disabled = false; chk.textContent = 'Проверить связь';
      if (!r) { if (m) { m.className = 'vc-msg err'; m.textContent = 'Проверка доступна только в приложении.'; } return; }
      const lines = [
        'Ключ: ' + (r.key ? 'есть' : 'НЕТ'),
        'Прокси: ' + (r.proxy || 'не используется'),
        'Fish Audio: ' + (r.fish === 'ok' ? 'работает' : r.fish),
        'Ollama: ' + (r.ollama && r.ollama.indexOf('ok') === 0 ? r.ollama : r.ollama),
      ];
      if (m) { m.className = 'vc-msg'; m.textContent = lines.join(' | '); }
    };
    const del = $('vaKeyDel'); if (del) del.onclick = async () => {
      if (!ipc) return;
      await ipc.invoke('voice:set-key', '');
      ttsKey = await ipc.invoke('voice:has-key');
      keyNotice = ''; render();
    };
    const log = $('vaLog'); if (log) log.scrollTop = log.scrollHeight;
  }

  async function saveVoiceSettings() {
    if (!ipc) return;
    const msg = $('vaKeyMsg');
    const keyEl = $('vaKey');
    const keyWasTyped = !!(keyEl && keyEl.dataset && keyEl.dataset.userTyped === '1');
    const key = (keyWasTyped && keyEl.value || '').trim();
    const ref = ($('vaVoiceId') && $('vaVoiceId').value || '').trim();
    const prx = ($('vaProxy') && $('vaProxy').value || '').trim();
    try {
      if (key) {
        const r = await ipc.invoke('voice:set-key', key);
        if (!r || !r.ok) { if (msg) { msg.className = 'vc-msg err'; msg.textContent = (r && r.error) || 'Не смог сохранить ключ.'; } return; }
      }
      await ipc.invoke('voice:set-voice', ref);
      await ipc.invoke('voice:set-proxy', prx);
      ttsKey = await ipc.invoke('voice:has-key');
      keyNotice = '';
      if (msg) { msg.className = 'vc-msg'; msg.textContent = 'Сохранено.'; }
      setTimeout(() => { showSettings = false; render(); }, 900);
    } catch (e) {
      if (msg) { msg.className = 'vc-msg err'; msg.textContent = String(e && e.message || e); }
    }
  }

  // Пробел — говорить, когда экран открыт и фокус не в поле ввода.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (window.__currentView !== 'voice') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    e.preventDefault(); startListening();
  });

  // сиды для тестов: дать эмулировать распознанную фразу
  window.__voiceEmit = (t) => handleUtterance(String(t));

  window.loadVoicePage = function () {
    render();
    // Узнаём, есть ли ключ озвучки (сам ключ сюда не приходит — только факт).
    if (ipc) ipc.invoke('voice:has-key').then((r) => { if (r) { ttsKey = r; render(); } }).catch(() => {});
  };

  /* ── AI-чат приложения тоже на локальную модель ──────────────────────────
   * Штатный чат шлёт вопрос на свой сервер (/api/admin/ai-chat), а тот уже
   * куда-то дальше. Перехватываем ровно этот один запрос и отвечаем на него
   * локальной Ollama — тем же мозгом, которым думает Edit. Если локально не
   * вышло, запрос уходит на сервер, как раньше: ничего не ломается.
   * Заодно чиним индикатор «Ollama — онлайн»: он спрашивал сервер, а тот про
   * локальную модель ничего не знает.
   */
  (function hookAppChat() {
    if (!ipc || typeof window === 'undefined') return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 40) { clearInterval(timer); return; }   // ждём ~20 сек и сдаёмся
      if (typeof window.api !== 'function' || window.__localBrainHooked) return;
      clearInterval(timer);
      window.__localBrainHooked = true;

      const origApi = window.api;
      window.api = async function (path, method, body) {
        // сам чат
        if (path === '/api/admin/ai-chat' && String(method).toUpperCase() === 'POST') {
          try {
            const r = await ipc.invoke('voice:ask', {
              text: (body && body.message) || '',
              history: (body && body.history) || [],
              mode: 'chat',
            });
            if (r && r.ok && r.text) return { response: stripThinking(r.text) };
          } catch {}
          // не получилось локально — пусть идёт по старому пути
        }
        // индикатор статуса
        if (path === '/api/status') {
          let res = null;
          try { res = await origApi.apply(this, arguments); } catch {}
          try {
            const l = await ipc.invoke('voice:llm');
            if (l && l.ok) {
              res = res || {};
              res.ollama = Object.assign({}, res.ollama, { available: true, model: l.model });
            }
          } catch {}
          if (res) return res;
        }
        return origApi.apply(this, arguments);
      };
      console.log('[Edit] AI-чат приложения подключён к локальной модели');
    }, 500);
  })();
})();
