/* vpn-client.js — экран VPN-клиента, как в Happ / Shadowrocket.
 *
 * Отдельный раздел «VPN клиент» рядом с «VPN tunnel» (тот со статистикой не
 * трогаю). Здесь: вставляешь ссылку или подписку → список серверов, большая
 * кнопка подключения, переключатель TUN / системный прокси. Подписок может быть
 * несколько: каждая — отдельная группа со своей шапкой (имя, остаток дней,
 * трафик), кнопкой обновления, кнопкой свернуть/развернуть и кнопкой удалить.
 * У каждого сервера цветной пинг и меню «…».
 *
 * Разбор — в vpn-core.js, прямо в интерфейсе, поэтому список работает без
 * сервера. Лимиты и обновление берутся из URL-подписки: запрос идёт через
 * Node (require('https') в renderer'е Electron), без CORS-ограничений браузера;
 * в обычном браузере — через window.__vpnFetch (для тестов) или fetch.
 * Подключение к движку (xray) — следующий шаг: кнопка зовёт window.vpnConnect,
 * который появится вместе с движком, экран менять не придётся.
 */
'use strict';

(function () {
  const LS_SUBS = 'vpn.subs';      // [{id,url,name,meta,collapsed,nodes}]
  const LS_SEL = 'vpn.sel';        // id выбранного сервера
  const LS_MODE = 'vpn.mode';      // tun | proxy
  const LS_SORT = 'vpn.sort';      // default | ping (сортировка серверов по пингу)
  // старые ключи одиночной подписки — читаем один раз для миграции
  const OLD_URL = 'vpn.sub.url', OLD_NODES = 'vpn.nodes', OLD_META = 'vpn.meta';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

  // Монохромные иконки в стиле приложения (наследуют цвет текста кнопки).
  const svg = (d, w) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICN = {
    add: svg('<path d="M12 5v14M5 12h14"/>'),
    paste: svg('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>'),
    ping: svg('<path d="M3 12h4l3 8 4-16 3 8h4"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>'),
    refresh: svg('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    sort: svg('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h4"/><path d="M11 8h7"/><path d="M11 12h10"/>'),
  };

  /* ── состояние ──────────────────────────────────────────────────────────── */
  let subs = [];             // [{id,url,name,meta,collapsed,nodes}]
  let selected = null;       // id выбранного сервера (глобально)
  let state = 'off';         // off | connecting | on
  let pings = {};            // id -> ms | null
  let refreshingId = null;   // id подписки, которую сейчас обновляем
  let pinging = false;
  let _sid = 0;

  /* ── мост к движку (main-процесс Electron) ──────────────────────────────── */
  // Реальное подключение делает vpn-engine.js в main-процессе. Здесь — вызовы
  // через ipcRenderer и подписка на изменения состояния (если движок сам упал
  // или прокси откатился — кнопка обновится без нашего участия).
  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch {}
  if (ipc) {
    if (typeof window.vpnConnect !== 'function') window.vpnConnect = (opts) => ipc.invoke('vpn:connect', opts);
    if (typeof window.vpnDisconnect !== 'function') window.vpnDisconnect = () => ipc.invoke('vpn:disconnect');
    ipc.on('vpn-state', (_e, st) => {
      if (!st) return;
      state = st.state || 'off';
      if (st.error) toastMsg(st.error);
      if ($('view-vpnclient')) render();
    });
  }

  const FLAGS = { 'герман':'🇩🇪','finlan':'🇫🇮','финлянд':'🇫🇮','swed':'🇸🇪','швец':'🇸🇪','брит':'🇬🇧','велико':'🇬🇧','uk':'🇬🇧','итал':'🇮🇹','ital':'🇮🇹','япон':'🇯🇵','japan':'🇯🇵','сша':'🇺🇸','usa':'🇺🇸','united states':'🇺🇸','турц':'🇹🇷','turk':'🇹🇷','нидерл':'🇳🇱','neth':'🇳🇱','франц':'🇫🇷','fran':'🇫🇷','испан':'🇪🇸','spain':'🇪🇸','синг':'🇸🇬','singap':'🇸🇬','польш':'🇵🇱','pol':'🇵🇱','youtube':'📺','глобал':'🌍' };
  function flagFor(name) {
    const s = String(name || '').toLowerCase();
    for (const k in FLAGS) if (s.includes(k)) return FLAGS[k];
    return '🌐';
  }
  function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }

  /* ── формат трафика/срока ───────────────────────────────────────────────── */
  function fmtBytes(b) {
    if (b == null) return '—';
    if (b <= 0) return '0 GB';
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
    if (gb >= 1) return gb.toFixed(2) + ' GB';
    return (b / (1024 * 1024)).toFixed(0) + ' MB';
  }
  function daysLeft(expireSec) {
    if (!expireSec) return null; // 0/пусто — бессрочно
    const ms = expireSec * 1000 - Date.now();
    return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
  }

  /* ── хранилище (несколько подписок) ─────────────────────────────────────── */
  function newSubId() { return 'sub' + Date.now().toString(36) + (_sid++).toString(36); }
  function allNodes() { const r = []; for (const s of subs) for (const n of s.nodes) r.push(n); return r; }
  function findSubOf(nodeId) { return subs.find((s) => s.nodes.some((n) => n.id === nodeId)); }

  // id сервера уникален в пределах всех подписок: завязан на id подписки + ссылку.
  function assignIds() {
    subs.forEach((s) => s.nodes.forEach((n, i) => {
      n.id = n.raw ? 'n' + hash(s.id + '|' + n.raw) : 's' + s.id + '_' + i;
    }));
  }
  function reselectIfNeeded() {
    const all = allNodes();
    if (!all.some((n) => n.id === selected)) selected = all[0] ? all[0].id : null;
  }

  function persistSubs() {
    try {
      const clean = subs.map((s) => ({
        id: s.id, url: s.url || '', name: s.name || '', meta: s.meta || null, collapsed: !!s.collapsed,
        nodes: s.nodes.map((n) => { const { id, ...rest } = n; return rest; }),
      }));
      lsSet(LS_SUBS, JSON.stringify(clean));
    } catch {}
    if (selected) lsSet(LS_SEL, selected); else lsDel(LS_SEL);
  }

  function loadStored() {
    try { subs = JSON.parse(lsGet(LS_SUBS, '[]')) || []; } catch { subs = []; }
    if (!Array.isArray(subs)) subs = [];

    // Миграция со старого одиночного формата (одна подписка на весь экран).
    if (!subs.length) {
      let oldNodes = []; try { oldNodes = JSON.parse(lsGet(OLD_NODES, '[]')) || []; } catch {}
      if (oldNodes.length) {
        let oldMeta = null; try { oldMeta = JSON.parse(lsGet(OLD_META, 'null')); } catch {}
        const url = lsGet(OLD_URL, '');
        subs = [{
          id: newSubId(), url: url || '', name: (oldMeta && oldMeta.name) || 'Моя подписка',
          meta: oldMeta ? { used: oldMeta.used, total: oldMeta.total, expire: oldMeta.expire } : null,
          collapsed: false, nodes: oldNodes,
        }];
        lsDel(OLD_NODES); lsDel(OLD_META); lsDel(OLD_URL);
        persistSubs();
      }
    }

    subs.forEach((s) => {
      if (!Array.isArray(s.nodes)) s.nodes = [];
      if (typeof s.collapsed !== 'boolean') s.collapsed = false;
    });
    assignIds();
    selected = lsGet(LS_SEL, null);
    reselectIfNeeded();
  }

  /* ── сеть: скачать подписку и прочитать лимиты ──────────────────────────── */
  // Многие сервера подписок отдают список серверов только «знакомым» клиентам
  // (смотрят на User-Agent), а незнакомым — HTML-страницу или пусто. Поэтому по
  // очереди представляемся популярными клиентами, пока не получим сервера.
  const SUB_UAS = ['v2rayNG/1.9.5', 'Shadowrocket/2.2', 'clash-verge/v1.6.0', 'sing-box/1.8', 'Mozilla/5.0'];

  function fetchSub(url, ua) {
    if (typeof window.__vpnFetch === 'function') return window.__vpnFetch(url, ua);
    // В Electron берём Node-модуль напрямую — так нет CORS и видны все заголовки.
    try {
      if (typeof require === 'function') {
        return new Promise((resolve, reject) => {
          const get = (u, redirects) => {
            let lib; try { lib = require(u.startsWith('https') ? 'https' : 'http'); } catch (e) { return reject(e); }
            const req = lib.get(u, { headers: { 'User-Agent': ua || SUB_UAS[0] } }, (res) => {
              if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 4) {
                res.resume(); return get(new URL(res.headers.location, u).href, redirects + 1);
              }
              let data = ''; res.setEncoding('utf8');
              res.on('data', (d) => (data += d));
              res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
            });
            req.setTimeout(12000, () => req.destroy(new Error('таймаут')));
            req.on('error', reject);
          };
          get(url, 0);
        });
      }
    } catch { /* fall through */ }
    // Обычный браузер: заголовки лимитов CORS чаще всего скрывает, но тело отдаёт.
    return fetch(url).then((r) => r.text().then((body) => ({ status: r.status, headers: {}, body })));
  }

  function parseUserinfo(headers) {
    const h = {}; for (const k in headers) h[k.toLowerCase()] = headers[k];
    const info = h['subscription-userinfo'];
    if (!info) return null;
    const o = {};
    String(info).split(';').forEach((p) => { const [k, v] = p.split('='); if (k) o[k.trim()] = Number(v); });
    return { used: (o.upload || 0) + (o.download || 0), total: o.total || 0, expire: o.expire || 0 };
  }
  function nameFromHeaders(headers, fallback) {
    const h = {}; for (const k in headers) h[k.toLowerCase()] = headers[k];
    let t = h['profile-title'] || '';
    if (t && /^base64:/i.test(t) && window.VpnCore) t = window.VpnCore.b64decode(t.replace(/^base64:/i, ''));
    if (!t) {
      const cd = h['content-disposition'] || '';
      const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
      if (m) { try { t = decodeURIComponent(m[1]); } catch { t = m[1]; } }
    }
    return t || fallback;
  }

  /* ── импорт и обновление ────────────────────────────────────────────────── */
  function isUrl(s) { return /^https?:\/\/\S+$/i.test(String(s).trim()); }

  // Добавляет НОВУЮ подписку (или обновляет уже существующую с тем же URL).
  // Именно так набирается несколько подписок: каждый «Добавить/Вставить» — плюс одна.
  async function importText(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, msg: 'Пусто.' };
    if (!window.VpnCore) return { ok: false, msg: 'ядро не загружено' };

    if (isUrl(t)) {
      let s = subs.find((x) => x.url === t);
      const isNew = !s;
      if (isNew) { s = { id: newSubId(), url: t, name: 'Моя подписка', meta: null, collapsed: false, nodes: [] }; subs.push(s); }
      const res = await refreshSub(s);
      if (res.count) return { ok: true, msg: (isNew ? 'Подписка добавлена: серверов ' : 'Подписка обновлена: серверов ') + res.count };
      if (isNew && !s.nodes.length) { subs = subs.filter((x) => x !== s); persistSubs(); render(); }
      return { ok: false, msg: res.error || 'Не удалось загрузить подписку по ссылке.' };
    }

    const parsed = window.VpnCore.parseSubscription(t);
    if (!parsed.length) return { ok: false, msg: 'Не нашёл ни одного сервера. Вставьте vless:// / trojan:// / vmess:// / ss:// или подписку.' };
    const s = { id: newSubId(), url: '', name: 'Добавлено вручную', meta: null, collapsed: false, nodes: parsed };
    subs.push(s);
    assignIds();
    reselectIfNeeded();
    persistSubs();
    render(); pingAll();
    return { ok: true, msg: `Добавлено серверов: ${parsed.length}` };
  }

  async function refreshSub(s) {
    if (!s || !s.url) { reselectIfNeeded(); persistSubs(); render(); return { count: s ? s.nodes.length : 0 }; }
    refreshingId = s.id; render();
    try {
      let lastStatus = '?', lastErr = null, r = null;
      // Пробуем по очереди разные User-Agent: некоторые сервера (mutterer.stream
      // и подобные) отдают сервера только знакомому клиенту.
      for (const ua of SUB_UAS) {
        try { r = await fetchSub(s.url, ua); } catch (e) { lastErr = e; continue; }
        lastStatus = r.status || lastStatus;
        const parsed = window.VpnCore.parseSubscription(r.body || '');
        if (parsed.length) {
          s.nodes = parsed;
          const info = parseUserinfo(r.headers || {});
          s.name = nameFromHeaders(r.headers || {}, s.name || 'Моя подписка');
          if (info) s.meta = { used: info.used, total: info.total, expire: info.expire };
          assignIds(); reselectIfNeeded(); persistSubs();
          return { count: parsed.length };
        }
      }
      if (lastErr) return { count: 0, error: 'Ошибка сети: ' + (lastErr.message || lastErr) };
      return { count: 0, error: 'В ответе подписки нет серверов (код ' + lastStatus + '). Проверьте ссылку.' };
    } finally {
      refreshingId = null; render(); pingAll();
    }
  }

  function deleteSub(id) {
    subs = subs.filter((s) => s.id !== id);
    reselectIfNeeded();
    persistSubs();
    render();
  }
  function toggleCollapse(id) {
    const s = subs.find((x) => x.id === id);
    if (!s) return;
    s.collapsed = !s.collapsed;
    persistSubs();
    render();
  }

  /* ── подключение (заглушка под движок) ──────────────────────────────────── */
  async function connect() {
    const node = allNodes().find((n) => n.id === selected);
    if (!node) { toastMsg('Сначала выберите сервер.'); return; }
    if (typeof window.vpnConnect !== 'function') {
      toastMsg('VPN работает только внутри приложения (нужен движок в main-процессе).'); return;
    }
    state = 'connecting'; render();
    try {
      const res = await window.vpnConnect({ node, mode: lsGet(LS_MODE, 'proxy') });
      if (res && res.ok) {
        state = 'on';
        if (res.note) toastMsg(res.note);
      } else {
        state = 'off';
        if (res && res.needEngine) openEngineDialog(res);
        else toastMsg((res && res.error) || 'Не удалось подключиться.');
      }
    } catch (e) { state = 'off'; toastMsg('Ошибка: ' + (e && e.message ? e.message : e)); }
    render();
  }
  async function disconnect() { try { if (typeof window.vpnDisconnect === 'function') await window.vpnDisconnect(); } catch {} state = 'off'; render(); }
  function toggleConnect() { if (state === 'on') disconnect(); else if (state === 'off') connect(); }
  function toastMsg(m) { if (typeof toast === 'function') toast(m); else console.log(m); }

  /* ── пинг ───────────────────────────────────────────────────────────────── */

  /**
   * Время TCP-подключения к серверу. Меряется прямо здесь через Node (require
   * доступен в renderer'е Electron), поэтому «Тест пинга» работает уже сейчас,
   * без движка. Это не ICMP-ping, а время открытия порта — как раз то, что
   * важно для VPN-сервера, и именно так меряют пинг клиенты вроде Happ.
   */
  function tcpPing(host, port) {
    return new Promise((resolve) => {
      let net; try { net = require('net'); } catch { return resolve(null); }
      const started = Date.now();
      const sock = net.connect({ host: host, port: port || 443 });
      let done = false;
      const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(v); };
      sock.setTimeout(4000);
      sock.once('connect', () => finish(Date.now() - started));
      sock.once('timeout', () => finish(null));
      sock.once('error', () => finish(null)); // порт закрыт/недоступен — пинга нет
    });
  }

  /** Есть window.vpnPing (от движка) — берём его; иначе меряем TCP сами. */
  function pingOne(host, port) {
    if (typeof window.vpnPing === 'function') { try { return window.vpnPing(host, port); } catch { return Promise.resolve(null); } }
    return tcpPing(host, port);
  }

  async function pingAll() {
    const all = allNodes();
    if (pinging || !all.length) return;
    pinging = true; render();
    // Параллельно — иначе десяток серверов по таймауту это полминуты ожидания.
    await Promise.all(all.map(async (n) => { try { pings[n.id] = await pingOne(n.host, n.port); } catch { pings[n.id] = null; } }));
    pinging = false; render();
  }
  function pingClass(ms) { if (ms == null) return 'vc-ping-none'; if (ms < 100) return 'vc-ping-good'; if (ms < 250) return 'vc-ping-ok'; return 'vc-ping-bad'; }

  function sortMode() { return lsGet(LS_SORT, 'default'); }

  /* Порядок серверов для показа: обычный (как в подписке) или по пингу — от
     меньшего к большему; непроверенные (—) уходят вниз. Хранимый порядок не
     меняем, сортируем только отображение. */
  function sortedNodes(list) {
    if (sortMode() !== 'ping') return list;
    return list.slice().sort((a, b) => {
      const va = pings[a.id] == null ? Infinity : pings[a.id];
      const vb = pings[b.id] == null ? Infinity : pings[b.id];
      return va - vb;
    });
  }

  /* ── меню «…» на сервере ────────────────────────────────────────────────── */
  function openRowMenu(id, anchor) {
    closeRowMenu();
    const n = allNodes().find((x) => x.id === id);
    if (!n) return;
    const m = document.createElement('div');
    m.className = 'vc-menu';
    m.innerHTML = `
      <button data-act="main">Сделать основным</button>
      <button data-act="copy">Копировать ссылку</button>
      <button data-act="del">Удалить сервер</button>`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 4) + 'px';
    m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    m.querySelector('[data-act="main"]').onclick = () => { selected = id; lsSet(LS_SEL, id); closeRowMenu(); render(); };
    m.querySelector('[data-act="copy"]').onclick = () => { copyText(n.raw || ''); closeRowMenu(); toastMsg('Ссылка скопирована'); };
    m.querySelector('[data-act="del"]').onclick = () => {
      const s = findSubOf(id);
      if (s) { s.nodes = s.nodes.filter((x) => x.id !== id); if (!s.nodes.length) subs = subs.filter((x) => x !== s); }
      reselectIfNeeded(); persistSubs();
      closeRowMenu(); render();
    };
    setTimeout(() => document.addEventListener('click', closeRowMenu, { once: true }), 0);
  }
  function closeRowMenu() { const m = document.querySelector('.vc-menu'); if (m) m.remove(); }
  function copyText(t) {
    try { if (navigator.clipboard) return navigator.clipboard.writeText(t); } catch {}
    try { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); } catch {}
  }

  // Подтверждение удаления подписки — маленькое всплывающее окно у кнопки.
  function confirmDeleteSub(id, anchor) {
    closeRowMenu();
    const s = subs.find((x) => x.id === id);
    if (!s) return;
    const m = document.createElement('div');
    m.className = 'vc-menu vc-confirm';
    m.innerHTML = `
      <div class="vc-menu-t">Удалить «${esc(s.name || 'подписку')}» и её серверы?</div>
      <button data-act="del">Удалить подписку</button>
      <button data-act="cancel">Отмена</button>`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 4) + 'px';
    m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    m.querySelector('[data-act="del"]').onclick = () => { deleteSub(id); closeRowMenu(); };
    m.querySelector('[data-act="cancel"]').onclick = () => closeRowMenu();
    setTimeout(() => document.addEventListener('click', closeRowMenu, { once: true }), 0);
  }

  /* ── отрисовка ──────────────────────────────────────────────────────────── */
  function protoChips(n) {
    const chips = [n.protocol]; if (n.network) chips.push(n.network); if (n.security && n.security !== 'none') chips.push(n.security);
    return chips.map((c) => `<span class="vc-chip">${esc(String(c).toUpperCase())}</span>`).join('');
  }
  function statusText() {
    if (state === 'on') { const n = allNodes().find((x) => x.id === selected); return 'Подключено' + (n ? ' · ' + esc(n.name) : ''); }
    if (state === 'connecting') return 'Подключение…';
    return 'Нажмите для подключения';
  }

  function rowHtml(n, i) {
    const ms = pings[n.id];
    const pingTxt = ms == null ? '—' : ms + '<span>мс</span>';
    return `<div class="vc-row${n.id === selected ? ' sel' : ''}" data-id="${esc(n.id)}" style="animation-delay:${Math.min(i, 12) * 25}ms">
      <span class="vc-dot ${pingClass(ms)}"></span>
      <span class="vc-flag">${flagFor(n.name)}</span>
      <div class="vc-info"><div class="vc-name">${esc(n.name)}</div><div class="vc-chips">${protoChips(n)}</div></div>
      <div class="vc-ping ${pingClass(ms)}">${pingTxt}</div>
      <button class="vc-more" data-more="${esc(n.id)}" aria-label="Меню">⋯</button>
    </div>`;
  }

  // Одна подписка = группа: шапка + (если развёрнута) лимиты и список серверов.
  function subGroup(s) {
    const d = s.meta ? daysLeft(s.meta.expire) : null;
    const left = d == null ? '' : (d > 0 ? `Осталось ${d} д` : 'Срок истёк');
    const traffic = s.meta && s.meta.total ? `${fmtBytes(s.meta.used)} / ${fmtBytes(s.meta.total)}`
      : (s.meta && s.meta.used ? `${fmtBytes(s.meta.used)} / ∞` : '');
    const spinning = refreshingId === s.id;
    const bar = s.meta && s.meta.total
      ? `<div class="vc-bar"><i style="width:${Math.min(100, Math.round((s.meta.used / s.meta.total) * 100))}%"></i></div>` : '';
    const rows = s.nodes.length
      ? sortedNodes(s.nodes).map((n, i) => rowHtml(n, i)).join('')
      : `<div class="vc-empty">В этой подписке нет серверов. Обновите её или удалите.</div>`;

    return `
      <div class="vc-group" data-sub="${esc(s.id)}">
        <div class="vc-sub">
          <div class="vc-sub-top">
            <div class="vc-sub-lead">
              <button class="vc-collapse${s.collapsed ? ' closed' : ''}" data-collapse="${esc(s.id)}" title="${s.collapsed ? 'Развернуть' : 'Свернуть'}" aria-label="Свернуть">${ICN.chevron}</button>
              <div class="vc-sub-name">${esc(s.name || 'Подписка')} <span class="vc-spark">✦</span><span class="vc-sub-count">${s.nodes.length}</span></div>
            </div>
            <div class="vc-sub-btns">
              ${s.url ? `<button class="vc-sub-btn${spinning ? ' spin' : ''}" data-refresh="${esc(s.id)}" title="Обновить подписку" aria-label="Обновить">${ICN.refresh}</button>` : ''}
              <button class="vc-sub-btn danger" data-del="${esc(s.id)}" title="Удалить подписку" aria-label="Удалить">${ICN.trash}</button>
            </div>
          </div>
          ${!s.collapsed && (left || traffic) ? `<div class="vc-sub-meta"><span>${esc(left)}</span><span class="vc-traffic">${esc(traffic)}</span></div>` : ''}
          ${!s.collapsed ? bar : ''}
        </div>
        ${!s.collapsed ? `<div class="vc-list">${rows}</div>` : ''}
      </div>`;
  }

  function render() {
    const host = $('view-vpnclient');
    if (!host) return;
    const mode = lsGet(LS_MODE, 'proxy');
    const total = allNodes().length;

    const groups = subs.length
      ? subs.map(subGroup).join('')
      : `<div class="vc-empty">Пока нет подписок. Нажмите «Добавить» или «Вставить» — можно добавить несколько ссылок или подписок.</div>`;

    host.innerHTML = `
      <div class="vc-wrap">
        <div class="vc-modes">
          <button class="vc-mode${mode === 'tun' ? ' on' : ''}" data-mode="tun">TUN</button>
          <button class="vc-mode${mode === 'proxy' ? ' on' : ''}" data-mode="proxy">Системный прокси</button>
        </div>
        <button class="vc-power ${state}" id="vcPower" title="Подключить / отключить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>
        </button>
        <div class="vc-status">${statusText()}</div>
        <div class="vc-actions">
          <button class="btn btn-primary vc-act" id="vcAdd">${ICN.add} Добавить</button>
          <button class="btn btn-ghost vc-act" id="vcPaste">${ICN.paste} Вставить</button>
          <button class="btn btn-ghost vc-act${pinging ? ' busy' : ''}" id="vcPing"${total ? '' : ' disabled'}>${ICN.ping} ${pinging ? 'Проверяю…' : 'Тест пинга'}</button>
        </div>
        ${total ? `<div class="vc-sortbar">
          <button class="vc-sort${sortMode() === 'ping' ? ' on' : ''}" id="vcSort" title="Сортировать серверы по пингу">${ICN.sort} ${sortMode() === 'ping' ? 'По пингу ↑' : 'Сортировать по пингу'}</button>
        </div>` : ''}
        <div class="vc-groups">${groups}</div>
      </div>`;

    $('vcPower').onclick = toggleConnect;
    $('vcAdd').onclick = $('vcPaste').onclick = openPaste;
    const pb = $('vcPing'); if (pb) pb.onclick = () => { if (!pinging) pingAll(); };
    const sb = $('vcSort'); if (sb) sb.onclick = () => {
      lsSet(LS_SORT, sortMode() === 'ping' ? 'default' : 'ping');
      render();
      // Нет свежих замеров — сразу их снимем, чтобы сортировать было по чему.
      if (sortMode() === 'ping' && !Object.keys(pings).length) pingAll();
    };

    host.querySelectorAll('.vc-mode').forEach((b) => (b.onclick = () => { lsSet(LS_MODE, b.dataset.mode); render(); }));
    host.querySelectorAll('[data-collapse]').forEach((b) => (b.onclick = () => toggleCollapse(b.dataset.collapse)));
    host.querySelectorAll('[data-refresh]').forEach((b) => (b.onclick = () => {
      const s = subs.find((x) => x.id === b.dataset.refresh);
      if (s && refreshingId !== s.id) refreshSub(s);
    }));
    host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); confirmDeleteSub(b.dataset.del, b); }));
    host.querySelectorAll('.vc-row').forEach((r) => {
      r.onclick = (e) => { if (e.target.closest('.vc-more')) return; selected = r.dataset.id; lsSet(LS_SEL, selected); render(); };
    });
    host.querySelectorAll('.vc-more').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openRowMenu(b.dataset.more, b); };
    });
  }

  /* ── окно вставки подписки ──────────────────────────────────────────────── */
  function openPaste() {
    if ($('vcPasteOverlay')) return;
    const el = document.createElement('div');
    el.id = 'vcPasteOverlay'; el.className = 'vc-overlay';
    el.innerHTML = `
      <div class="vc-card">
        <div class="vc-card-head"><h3>Добавить подписку</h3><button class="vc-x" id="vcClose" aria-label="Закрыть">✕</button></div>
        <p class="vc-hint">Вставьте ссылку (vless:// trojan:// vmess:// ss://), ссылку-подписку (https://…) или подписку целиком. Можно добавлять несколько — каждая станет отдельной группой.</p>
        <textarea id="vcArea" class="vc-area" placeholder="vless://…   или   https://sub.example/...   или   base64"></textarea>
        <div class="vc-msg" id="vcMsg"></div>
        <div class="vc-card-foot"><button class="btn" id="vcCancel">Отмена</button><button class="btn btn-primary" id="vcSave">Добавить</button></div>
      </div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    $('vcClose').onclick = $('vcCancel').onclick = close;
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { if (t && (/:\/\//.test(t) || t.length > 40)) $('vcArea').value = t; }).catch(() => {});
    $('vcArea').focus();
    $('vcSave').onclick = async () => {
      const btn = $('vcSave'); btn.disabled = true; btn.textContent = 'Загрузка…';
      const res = await importText($('vcArea').value);
      btn.disabled = false; btn.textContent = 'Добавить';
      const msg = $('vcMsg');
      if (res.ok) { close(); toastMsg(res.msg); } else { msg.textContent = res.msg; msg.className = 'vc-msg err'; }
    };
  }

  /* ── окно «нужен движок» ────────────────────────────────────────────────── */
  function openEngineDialog(res) {
    if ($('vcEngineOverlay')) return;
    const dir = (res && res.engineDir) || '';
    const el = document.createElement('div');
    el.id = 'vcEngineOverlay'; el.className = 'vc-overlay';
    el.innerHTML = `
      <div class="vc-card">
        <div class="vc-card-head"><h3>Нужен движок Xray</h3><button class="vc-x" id="vcEngClose" aria-label="Закрыть">✕</button></div>
        <p class="vc-hint">Для реального подключения нужен движок <b>xray.exe</b> — как внутри Happ. Можно скачать автоматически с официального GitHub (с проверкой контрольной суммы). Если провайдер его блокирует — положи <b>xray.exe</b> в папку движка вручную и снова нажми кнопку подключения.</p>
        <div class="vc-msg" id="vcEngMsg">${dir ? 'Папка движка: ' + esc(dir) : ''}</div>
        <div class="vc-card-foot">
          <button class="btn" id="vcEngOpen">Открыть папку</button>
          <button class="btn btn-primary" id="vcEngDl">Скачать Xray</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    $('vcEngClose').onclick = close;
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    $('vcEngOpen').onclick = () => { if (ipc) ipc.invoke('vpn:open-engine-dir'); };
    $('vcEngDl').onclick = async () => {
      const b = $('vcEngDl'); b.disabled = true; b.textContent = 'Скачиваю…';
      const m = $('vcEngMsg'); m.className = 'vc-msg'; m.textContent = 'Скачиваю движок с GitHub…';
      let r = null;
      try { r = ipc ? await ipc.invoke('vpn:download-engine') : { ok: false, error: 'Нет доступа к движку.' }; }
      catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      b.disabled = false; b.textContent = 'Скачать Xray';
      if (r && r.ok) { m.textContent = 'Движок установлен' + (r.version ? ' (' + r.version + ')' : '') + '. Теперь нажмите кнопку подключения.'; setTimeout(close, 1600); }
      else { m.className = 'vc-msg err'; m.textContent = (r && r.error) || 'Не удалось скачать.'; }
    };
  }

  window.loadVpnClientPage = function () { loadStored(); render(); pingAll(); };
})();
