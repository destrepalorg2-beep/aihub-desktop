/* admin-renderer.js — AI Server Hub */
'use strict';

const { ipcRenderer } = require('electron');

// ── Window Controls ────────────────────────────────────────────────────────────────
function windowControl(action) {
  ipcRenderer.invoke(`window-${action}`);
}

const API = 'http://localhost:3000';

const ADMIN_TOKEN = 'admin-secret-token-2024';

// ── API helper ────────────────────────────────────────────────────────────────
// Каждый запрос отмечается в счётчике, по которому в шапке крутится фирменная
// анимация загрузки. Счётчик, а не флаг: запросов часто несколько сразу, и
// флаг погас бы на первом же ответе, пока остальные ещё в пути.
async function api(path, method = 'GET', body = null) {
  if (typeof netBusy === 'function') netBusy(1);
  try {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (typeof netBusy === 'function') netBusy(-1);
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Format helpers ────────────────────────────────────────────────────────────
// formatUptime lives further down, next to the overview that uses it most.

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// ── LOGS SYSTEM ───────────────────────────────────────────────────────────────
const appLogs = [];
let autoScroll = true;
let currentLogFilter = 'all';

// Safe console override — only after DOM ready
function setupLogCapture() {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };

  function capture(level, ...args) {
    const timestamp = new Date().toLocaleTimeString('ru');
    const message = args.map(a => {
      try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch { return String(a); }
    }).join(' ');
    appLogs.push({ timestamp, level, message });
    if (appLogs.length > 500) appLogs.shift();
    updateLogsIfVisible();
    orig[level](...args);
  }

  console.log = (...a) => capture('info', ...a);
  console.info = (...a) => capture('info', ...a);
  console.warn = (...a) => capture('warn', ...a);
  console.error = (...a) => capture('error', ...a);
}

function updateLogsIfVisible() {
  const el = document.getElementById('view-logs');
  if (el && el.classList.contains('active')) renderLogs();
}

function loadLogsPage() {
  renderLogs();
  updateLogStats();
}

function renderLogs() {
  const container = document.getElementById('logsContainer');
  if (!container) return;
  const filtered = currentLogFilter === 'all' ? appLogs : appLogs.filter(l => l.level === currentLogFilter);
  container.innerHTML = filtered.map(l => {
    const lvlStyle = l.level === 'error'
      ? 'background:var(--danger-soft);color:var(--danger)'
      : l.level === 'warn'
        ? 'background:var(--warn-soft);color:var(--warn)'
        : 'background:var(--accent-soft);color:var(--accent-txt)';
    return `<div class="log-item${l.level === 'warn' ? ' warn' : l.level === 'error' ? ' error' : ''}">
      <span class="log-time">${l.timestamp}</span>
      <span class="log-level" style="${lvlStyle}">${l.level.toUpperCase()}</span>
      <span class="log-msg">${escHtml(l.message)}</span>
    </div>`;
  }).join('');
  if (autoScroll) container.scrollTop = container.scrollHeight;
}

function updateLogStats() {
  const total = appLogs.length;
  const errors = appLogs.filter(l => l.level === 'error').length;
  const warns = appLogs.filter(l => l.level === 'warn').length;
  const infos = appLogs.filter(l => l.level === 'info').length;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('logTotal', total); set('logErrors', errors); set('logWarns', warns); set('logInfos', infos);
}

function clearLogs() {
  appLogs.length = 0;
  renderLogs();
  updateLogStats();
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('autoScrollBtn');
  if (btn) btn.textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
}

function filterLogs(level, el) {
  currentLogFilter = level;
  document.querySelectorAll('.log-filter').forEach(f => f.classList.remove('active'));
  if (el) el.classList.add('active');
  renderLogs();
}

// ── OVERVIEW ──────────────────────────────────────────────────────────────────

/**
 * Translate.
 *
 * The dictionary and t() live in admin.html, which is parsed after this file.
 * By the time anything here runs they exist, but falling back to the key keeps
 * a panel rendering instead of blanking out if that ever stops being true.
 */
const tr = (k) => (typeof t === 'function' ? t(k) : k);

/** "2 дн 4 ч" / "18 мин" — uptime at a glance, not to the second. */
function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} дн ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

/** Thousands separated, so 128394 reads as a number and not as a serial. */
const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Sets text and swaps the ok/bad/muted colour class in one go. */
function setState(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'bad', 'muted');
  if (cls) el.classList.add(cls);
}

async function loadOverview() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  // One request for the whole dashboard, and always the widest range the
  // buttons offer — the range switch then slices what is already here.
  const start = Date.now();
  const ov = await api('/api/admin/overview?days=30');
  const latency = Date.now() - start;

  const online = !!ov;
  const server = ov?.server ?? null;
  const totals = ov?.totals ?? null;
  const people = ov?.users ?? null;

  // Chart: real series, or nothing at all. renderChart() draws the empty state.
  window.ovActivity = Array.isArray(ov?.activity) ? ov.activity : null;
  if (typeof renderChart === 'function') renderChart();

  set('ovTotalUsers', totals?.users ?? '—');
  set('ovNewWeek', people?.newThisWeek ?? '—');
  set('ovActiveSubs', totals?.activeSubscriptions ?? 0);
  set('ovLatency', online ? latency + 'мс' : '—');

  // Requests over the window, with a trend only when there is a real previous
  // period to compare against.
  const trend = ov?.trend ?? null;
  set('ovMsgs', trend ? num(trend.current) : '—');
  const badge = document.getElementById('ovTrend');
  const trendSub = document.getElementById('ovTrendSub');
  if (badge) {
    const pct = trend?.changePct;
    if (pct === null || pct === undefined) {
      badge.hidden = true;
      if (trendSub) trendSub.textContent = tr('ov.noTrend');
    } else {
      badge.hidden = false;
      badge.textContent = (pct > 0 ? '+' : '') + pct + '%';
      badge.className = 'pill-badge ' + (pct >= 0 ? 'badge-up' : 'badge-down');
      if (trendSub) trendSub.textContent = tr('ov.vsPrev');
    }
  }

  // Live server state.
  setState('ovSrvState', online ? 'онлайн' : tr('ov.offline'), online ? 'ok' : 'bad');
  setState('ovConns', server ? num(server.activeConnections) : '—', server ? null : 'muted');
  setState('ovUptime', server ? formatUptime(server.uptimeSeconds) : '—', server ? null : 'muted');
  setState('ovProvider', server?.aiProvider ?? '—', server ? null : 'muted');
  setState(
    'ovOllama',
    server?.ollamaAvailable === true ? 'работает'
      : server?.ollamaAvailable === false ? 'недоступна'
      : '—',
    server?.ollamaAvailable === true ? 'ok' : server?.ollamaAvailable === false ? 'bad' : 'muted',
  );
  setState('ovTokens', totals ? num(totals.tokensUsed) : '—', totals ? null : 'muted');

  const statusEl = document.getElementById('serverStatus');
  if (statusEl) statusEl.textContent = online ? `Сервер онлайн · ${latency}мс` : 'Сервер недоступен';

  // Models
  const modelsEl = document.getElementById('ovModels');
  if (modelsEl) {
    const models = await api('/api/models');
    const list = models?.models ?? [];
    set('ovModelCount', list.length);
    if (list.length === 0) {
      modelsEl.innerHTML = '<div style="font-size:12px;color:var(--t3)">Нет моделей</div>';
    } else {
      modelsEl.innerHTML = list.slice(0, 4).map(m =>
        `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;">
          <span style="display:flex;align-items:center;gap:8px;">
            <span style="width:7px;height:7px;border-radius:50%;background:var(--ok)"></span>${escHtml(m.name)}
          </span>
          <span style="color:var(--t3)">${formatBytes(m.size)}</span>
        </div>`
      ).join('');
    }
  }

  // Recent users. The status badge is the person's real subscription state —
  // it used to say "paused" for everyone, whatever their actual plan was.
  const tbody = document.getElementById('ovUsersTable');
  if (tbody) {
    const recent = (people?.recent ?? []).slice(0, 5);
    if (!recent.length) {
      tbody.innerHTML = `<tr><td colspan="2" style="color:var(--t3);font-size:12px;padding:14px 2px">—</td></tr>`;
    } else {
      const TONE = {
        active:   ['var(--ok-soft)', 'var(--ok)'],
        paused:   ['var(--warn-soft)', 'var(--warn)'],
        cancelled:['var(--s2)', 'var(--t3)'],
        expired:  ['var(--s2)', 'var(--t3)'],
      };
      tbody.innerHTML = recent.map(u => {
        const name = u.nickname || u.email || '—';
        const initials = name.substring(0, 2).toUpperCase();
        const colors = ['#7b76ff','#f0554f','#3ecf8e','#f0a93f','#5dd9c1'];
        const color = colors[Math.abs(initials.charCodeAt(0)) % colors.length];
        const label = u.status ? (u.plan ? `${u.plan} · ${u.status}` : u.status) : tr('st.none');
        const [bg, fg] = TONE[u.status] ?? ['var(--s2)', 'var(--t3)'];
        return `<tr class="row">
          <td><div class="cell-user"><div class="avatar" style="background:${color}">${escHtml(initials)}</div>${escHtml(name)}</div></td>
          <td style="text-align:right"><span class="badge" style="background:${bg};color:${fg}">${escHtml(label)}</span></td>
        </tr>`;
      }).join('');
    }
  }
}

// ── USERS ─────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const data = await api('/api/admin/users');
  const users = data?.users ?? [];

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('usrTotal', users.length);

  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Нет пользователей</td></tr>';
    return;
  }

  const colors = ['#7b76ff','#f0554f','#3ecf8e','#f0a93f','#5dd9c1'];
  tbody.innerHTML = users.map(u => {
    const initials = (u.nickname || u.email || '?').substring(0, 2).toUpperCase();
    const color = colors[Math.abs(initials.charCodeAt(0)) % colors.length];
    const hasSub = !!u.plan;
    const statusBadge = u.subscriptionStatus === 'active'
      ? `<span class="badge" style="background:var(--ok-soft);color:var(--ok)">active</span>`
      : hasSub
        ? `<span class="badge" style="background:var(--warn-soft);color:var(--warn)">${escHtml(u.subscriptionStatus || 'paused')}</span>`
        : `<span class="badge" style="background:var(--s2);color:var(--t3)">нет подписки</span>`;
    const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleDateString('ru') : '—';
    return `<tr class="row">
      <td><div class="cell-user"><div class="avatar" style="background:${color}">${escHtml(initials)}</div>${escHtml(u.nickname || '—')}</div></td>
      <td style="color:var(--t3)">${escHtml(u.email || '—')}</td>
      <td>${escHtml(u.plan || '—')}</td>
      <td>${num(u.tokensUsed || 0)}</td>
      <td style="color:var(--t3)">—</td>
      <td style="color:var(--t3)">${lastActive}</td>
      <td style="text-align:right">${statusBadge}</td>
    </tr>`;
  }).join('');
}

function addUser() {
  const email = prompt('Email пользователя:');
  if (!email) return;
  const nickname = prompt('Никнейм:') || email.split('@')[0];
  api('/api/admin/users', 'POST', { email, nickname })
    .then(r => { if (r) { toast('✅ Пользователь добавлен'); loadUsers(); } else toast('❌ Ошибка'); });
}

// ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────────
async function loadSubscriptions() {
  const [statsData, subsData] = await Promise.all([
    api('/api/admin/statistics'),
    api('/api/admin/subscriptions'),
  ]);
  const active = statsData?.statistics?.activeSubscriptions ?? 0;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('subActive', active);

  const tbody = document.getElementById('subsTableBody');
  const emptyEl = document.getElementById('subsEmpty');
  if (!tbody) return;

  const subs = subsData?.subscriptions ?? [];
  if (subs.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const TONE = {
    active:    ['var(--ok-soft)', 'var(--ok)'],
    paused:    ['var(--warn-soft)', 'var(--warn)'],
    cancelled: ['var(--s2)', 'var(--t3)'],
    expired:   ['var(--s2)', 'var(--t3)'],
  };
  tbody.innerHTML = subs.map(s => {
    const [bg, fg] = TONE[s.status] ?? ['var(--s2)', 'var(--t3)'];
    const starts = s.startDate ? new Date(s.startDate).toLocaleDateString('ru') : '—';
    const ends = s.endDate ? new Date(s.endDate).toLocaleDateString('ru') : '—';
    return `<tr class="row">
      <td>${escHtml(s.nickname || s.email || s.userId)}</td>
      <td style="color:var(--t3)">${escHtml(s.type || '—')}</td>
      <td style="color:var(--t3)">—</td>
      <td style="color:var(--t3)">${starts}</td>
      <td style="color:var(--t3)">${ends}</td>
      <td style="text-align:right"><span class="badge" style="background:${bg};color:${fg}">${escHtml(s.status || '—')}</span></td>
    </tr>`;
  }).join('');
}

function grantSubscription() {
  const userId = prompt('ID пользователя:');
  if (!userId) return;
  const type = prompt('Тариф (DEFAULT / PRO / ULTRA):', 'PRO');
  if (!type) return;
  const days = parseInt(prompt('Дней:', '30') || '30');
  api('/api/admin/subscriptions', 'POST', { userId, subscriptionType: type, durationDays: days })
    .then(r => { if (r) { toast('✅ Подписка выдана'); loadSubscriptions(); } else toast('❌ Ошибка'); });
}

// ── QR ────────────────────────────────────────────────────────────────────────
let qrCountdownInterval = null;

async function loadQRPage() {
  const data = await api('/api/admin/qr-history');
  const history = data?.history ?? [];

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const active = history.filter(q => q.status === 'active').length;
  set('qrActive', active);
  set('qrUsed', history.filter(q => q.status === 'used').length);
  set('qrExpired', history.filter(q => q.status === 'expired').length);
  set('qrTotal', history.length);

  const tbody = document.getElementById('qrHistoryTable');
  if (tbody) {
    tbody.innerHTML = history.slice(0, 10).map(q => {
      const created = new Date(q.createdAt).toLocaleTimeString('ru');
      const expires = new Date(q.expiresAt).toLocaleTimeString('ru');
      const badgeStyle = q.status === 'active'
        ? 'background:var(--ok-soft);color:var(--ok)'
        : q.status === 'used'
          ? 'background:var(--accent-soft);color:var(--accent-txt)'
          : 'background:var(--danger-soft);color:var(--danger)';
      return `<tr class="row">
        <td style="font-family:ui-monospace,monospace;font-size:12px;">${escHtml(q.token?.substring(0, 16))}...</td>
        <td style="color:var(--t3)">${created}</td>
        <td style="color:var(--t3)">${expires}</td>
        <td style="color:var(--t3)">—</td>
        <td style="text-align:right"><span class="badge" style="${badgeStyle}">${q.status}</span></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty-row">Нет кодов</td></tr>';
  }
}

async function generateQR() {
  const data = await api('/api/admin/qr-access', 'POST');
  if (!data?.token) { toast('❌ Ошибка генерации QR'); return; }

  const canvas = document.getElementById('qrCanvas');
  if (canvas) {
    try {
      const QRCode = require('qrcode');
      const url = `http://localhost:3000/admin?token=${data.token}`;
      const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
      canvas.innerHTML = `<img src="${dataUrl}" style="width:200px;height:200px;border-radius:8px;">`;
    } catch {
      canvas.innerHTML = `<div style="font-size:11px;color:var(--t3);text-align:center;padding:12px;">${data.token.substring(0, 20)}...</div>`;
    }
  }

  // Countdown
  const countdownEl = document.getElementById('qrCountdown');
  if (countdownEl) {
    countdownEl.style.display = 'block';
    let remaining = 600;
    if (qrCountdownInterval) clearInterval(qrCountdownInterval);
    qrCountdownInterval = setInterval(() => {
      remaining--;
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      countdownEl.textContent = `Истекает через ${m}:${s.toString().padStart(2, '0')}`;
      if (remaining <= 0) {
        clearInterval(qrCountdownInterval);
        countdownEl.textContent = 'Код истёк';
      }
    }, 1000);
  }

  toast('✅ QR-код создан');
  setTimeout(loadQRPage, 500);
}

// ── SERVER STATUS ─────────────────────────────────────────────────────────────
async function loadServerStatus() {
  const [status, models] = await Promise.all([api('/api/status'), api('/api/models')]);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  if (status) {
    const el = document.getElementById('srvStatus');
    if (el) { el.textContent = 'Онлайн'; el.style.color = 'var(--ok)'; }
    set('srvUptime', formatUptime(status.uptime ?? 0));
    set('srvConns', status.activeConnections ?? 0);

    const aiProvider = status.aiProvider ?? 'ollama';
    set('srvAiProvider', aiProvider === 'claude' ? 'Claude AI' : 'Ollama');
    set('aiProviderType', aiProvider === 'claude' ? 'Claude AI' : 'Ollama');
    const aiTitleEl = document.getElementById('aiProviderTitle');
    if (aiTitleEl) aiTitleEl.textContent = aiProvider === 'claude' ? 'Claude AI' : 'Ollama';

    // DB status
    const dbEl = document.getElementById('srvDB');
    if (dbEl) {
      if (status.dataStoreAvailable) {
        dbEl.textContent = 'OK'; dbEl.style.background = 'var(--ok-soft)'; dbEl.style.color = 'var(--ok)';
      } else {
        dbEl.textContent = 'error'; dbEl.style.background = 'var(--danger-soft)'; dbEl.style.color = 'var(--danger)';
      }
    }

    // AI status
    const ollamaOk = status.ollama?.available;
    const claudeOk = status.claude?.available;
    const isOk = aiProvider === 'claude' ? claudeOk : ollamaOk;
    const aiStatusEl = document.getElementById('aiStatus');
    if (aiStatusEl) {
      aiStatusEl.textContent = isOk ? 'запущен' : 'остановлен';
      aiStatusEl.style.background = isOk ? 'var(--ok-soft)' : 'var(--danger-soft)';
      aiStatusEl.style.color = isOk ? 'var(--ok)' : 'var(--danger)';
    }

    // Show/hide Claude vs Ollama rows
    const showClaude = aiProvider === 'claude';
    ['claudeHostRow','claudePortRow'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = showClaude ? 'grid' : 'none';
    });
    ['ollamaUrlRow','ollamaModelsRow'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = showClaude ? 'none' : 'grid';
    });
    const ollamaPanel = document.getElementById('ollamaModelsPanel');
    if (ollamaPanel) ollamaPanel.style.display = showClaude ? 'none' : 'block';
  } else {
    const el = document.getElementById('srvStatus');
    if (el) { el.textContent = 'Офлайн'; el.style.color = 'var(--danger)'; }
  }

  set('srvPort', process.env.PORT || '3000');
  set('srvHost', process.env.HOST || '0.0.0.0');
  set('srvMaxConn', process.env.MAX_CONNECTIONS || '10');
  set('srvHeartbeat', (parseInt(process.env.HEARTBEAT_INTERVAL) || 10000) + ' мс');
  set('ollamaUrl', process.env.OLLAMA_API_URL || 'http://localhost:11434');
  set('claudeHost', process.env.CLAUDE_HOST || '127.0.0.1');
  set('claudePort', process.env.CLAUDE_PORT || '65432');

  const modelList = models?.models ?? [];
  set('ollamaModelsCount', modelList.length);
  renderOllamaModels(modelList);
}

function renderOllamaModels(list) {
  const tbody = document.getElementById('ollamaModelsTable');
  const emptyEl = document.getElementById('ollamaModelsEmpty');
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  tbody.innerHTML = list.map(m => `<tr class="row">
    <td>${escHtml(m.name || '—')}</td>
    <td style="color:var(--t3)">${formatBytes(m.size || 0)}</td>
    <td style="color:var(--t3)">${m.modified_at ? new Date(m.modified_at).toLocaleDateString('ru') : '—'}</td>
    <td style="text-align:right"><span class="badge" style="background:var(--ok-soft);color:var(--ok)">ready</span></td>
  </tr>`).join('');
}

async function refreshServerStatus() {
  await loadServerStatus();
  toast('✅ Статус обновлён');
}

async function refreshOllamaModels() {
  const models = await api('/api/models');
  renderOllamaModels(models?.models ?? []);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const data = await api('/api/admin/settings');
  if (!data) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  if (data.port) set('settingsPort', data.port);
  if (data.ollamaUrl) set('settingsOllamaUrl', data.ollamaUrl);
  if (data.smtpHost) set('settingsSmtpHost', data.smtpHost);
  if (data.smtpUser) set('settingsSmtpUser', data.smtpUser);
  if (data.smtpFrom) set('settingsSmtpFrom', data.smtpFrom);
}

async function saveAllSettings() {
  const get = id => { const el = document.getElementById(id); return el ? el.value : null; };
  const settings = {
    port: get('settingsPort'),
    host: get('settingsHost'),
    maxConnections: get('settingsMaxConn'),
    ollamaUrl: get('settingsOllamaUrl'),
    defaultModel: get('settingsDefaultModel'),
    aiProvider: get('settingsAiProvider'),
    claudeEnabled: get('settingsClaudeEnabled'),
    claudeHost: get('settingsClaudeHost'),
    claudePort: get('settingsClaudePort'),
    smtpHost: get('settingsSmtpHost'),
    smtpPort: get('settingsSmtpPort'),
    smtpUser: get('settingsSmtpUser'),
    smtpFrom: get('settingsSmtpFrom'),
  };
  const result = await api('/api/admin/settings', 'PUT', { settings });
  if (result) toast('✅ Настройки сохранены');
  else toast('❌ Ошибка сохранения');
}

// ── AI CHAT ───────────────────────────────────────────────────────────────────
let chatHistory = [];
let chatIsSending = false;
let chatProvider = 'ollama';
let chatModel = 'qwen2.5:14b';

function loadChatPage() {
  const savedProvider = localStorage.getItem('chatProvider') || 'qwen';
  const savedModel = localStorage.getItem('chatModel') || 'qwen2.5:14b';
  chatModel = savedModel;
  switchChatProvider(savedProvider, false);
  checkChatStatus();
}

function switchChatProvider(provider, save = true) {
  // "qwen" — это модель Ollama, не отдельный провайдер: визуально ведём себя
  // как 'ollama', но подставляем модель qwen2.5:14b.
  if (provider === 'qwen') {
    chatProvider = 'ollama';
    chatModel = 'qwen2.5:14b';
    if (save) {
      localStorage.setItem('chatProvider', 'qwen');
      localStorage.setItem('chatModel', chatModel);
    }
  } else {
    chatProvider = provider;
    if (save) localStorage.setItem('chatProvider', provider);
  }

  const btnOllama = document.getElementById('providerBtnOllama');
  const btnClaude = document.getElementById('providerBtnClaude');
  const modelWrap = document.getElementById('modelSelectorWrap');
  const claudeWrap = document.getElementById('claudeInfoWrap');

  if (provider === 'claude') {
    if (btnOllama) { btnOllama.classList.remove('active'); }
    if (btnClaude) { btnClaude.classList.add('active'); }
    if (modelWrap) modelWrap.style.display = 'none';
    if (claudeWrap) claudeWrap.style.display = 'flex';
  } else {
    if (btnOllama) { btnOllama.classList.add('active'); }
    if (btnClaude) { btnClaude.classList.remove('active'); }
    if (modelWrap) modelWrap.style.display = 'flex';
    if (claudeWrap) claudeWrap.style.display = 'none';
  }
  checkChatStatus();
}

function changeChatModel(model) {
  chatModel = model;
  localStorage.setItem('chatModel', model);
}

async function checkChatStatus() {
  const dotEl = document.getElementById('chatStatusDot');
  const textEl = document.getElementById('chatStatusText');
  if (!dotEl || !textEl) return;
  try {
    const status = await api('/api/status');
    const isOk = chatProvider === 'claude' ? status?.claude?.available : status?.ollama?.available;
    const name = chatProvider === 'claude' ? 'Claude AI' : 'Ollama';
    if (isOk) {
      dotEl.style.background = 'var(--ok)';
      textEl.textContent = name + ' — онлайн';
      textEl.style.color = 'var(--ok)';
    } else {
      dotEl.style.background = 'var(--danger)';
      textEl.textContent = name + ' — недоступен';
      textEl.style.color = 'var(--danger)';
    }
  } catch {
    dotEl.style.background = 'var(--t3)';
    textEl.textContent = 'Нет соединения';
  }
}

function clearChat() {
  chatHistory = [];
  const msgs = document.getElementById('chatMessages');
  if (!msgs) return;
  msgs.innerHTML = `<div class="msg-container">
    <div class="msg-content ai-msg">
      <div class="ai-bubble">
        <span class="ai-name">AI Ассистент</span>
        Чат очищен. Напиши что-нибудь!
      </div>
    </div>
  </div>`;
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

/* Pick a loader label that matches what the user asked for. */
function chatLoaderLabel(text) {
  const t = String(text || '').toLowerCase();
  if (/```|код|функци|function|скрипт|script|python|javascript|\bjs\b|программ|компонент|баг|ошибк|debug|регуляр|sql|api|класс\b/.test(t))
    return { title: 'Пишу код', sub: 'Готовлю решение…' };
  if (/переведи|перевод|translate|на английск|на русск|на польск/.test(t))
    return { title: 'Перевожу', sub: 'Подбираю формулировки…' };
  if (/таблиц|список|перечисли|сравни|плюсы и минус/.test(t))
    return { title: 'Составляю список', sub: 'Раскладываю по пунктам…' };
  if (/посчита|вычисли|сколько|реши|уравнени|математ|calculate/.test(t))
    return { title: 'Считаю', sub: 'Провожу вычисления…' };
  if (/придума|напиши.*(текст|письмо|пост|статью|историю|стих)|сочини|перепиши|сократи/.test(t))
    return { title: 'Пишу текст', sub: 'Подбираю слова…' };
  return { title: 'Генерирую текст', sub: 'Модель думает…' };
}

async function sendChatMessage() {
  if (chatIsSending) return;
  const inputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;

  // Ничего не выбрано (провайдер/модель) — не отправляем запрос вслепую,
  // просто просим выбрать модель, без иконки ассистента, по центру.
  if (!chatProvider) {
    const msgs = document.getElementById('chatMessages');
    if (msgs) {
      const hintDiv = document.createElement('div');
      hintDiv.className = 'msg-container ai-msg';
      hintDiv.innerHTML = `<div class="msg-content" style="justify-content:center; text-align:center;">
        <div class="ai-bubble" style="opacity:.7;">Пожалуйста, выберите модель</div>
      </div>`;
      msgs.appendChild(hintDiv);
      msgs.scrollTop = msgs.scrollHeight;
    }
    return;
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  chatIsSending = true;
  if (sendBtn) { sendBtn.style.opacity = '0.5'; sendBtn.style.cursor = 'not-allowed'; }

  if (chatProvider === 'claude') startClaude();

  chatHistory.push({ role: 'user', content: text });

  // Append user message
  const msgs = document.getElementById('chatMessages');
  if (msgs) {
    const userDiv = document.createElement('div');
    userDiv.className = 'msg-container user-msg';
    userDiv.innerHTML = `<div class="msg-content"><div class="user-bubble">${escHtml(text)}</div></div>`;
    msgs.appendChild(userDiv);

    // Show the "AI is thinking" tetris loader with a label that fits the request.
    const L = chatLoaderLabel(text);
    if (window.__setChatLoader) window.__setChatLoader(true, L.title, L.sub);
    msgs.scrollTop = msgs.scrollHeight;
  }

  try {
    // Give the agent access to the attached project folder, if any.
    const projCtx = (typeof window !== 'undefined' && window.projectContextForAI) ? window.projectContextForAI() : '';
    const res = await api('/api/admin/ai-chat', 'POST', {
      message: projCtx + text, provider: chatProvider, model: chatModel,
      history: chatHistory.slice(-10),
    });

    if (window.__setChatLoader) window.__setChatLoader(false);

    if (res?.response) {
      chatHistory.push({ role: 'assistant', content: res.response });
      if (msgs) {
        const aiDiv = document.createElement('div');
        aiDiv.className = 'msg-container ai-msg';
        aiDiv.innerHTML = `<div class="msg-content">
          <div class="ai-bubble">
            <span class="ai-name">AI Ассистент</span>${escHtml(res.response)}
          </div>
        </div>`;
        msgs.appendChild(aiDiv);
        msgs.scrollTop = msgs.scrollHeight;
      }
    } else {
      const hint = chatProvider === 'claude' ? 'Запустите python claude_bridge.py' : 'Запустите Ollama';
      if (msgs) {
        const aiDiv = document.createElement('div');
        aiDiv.className = 'msg-container ai-msg';
        aiDiv.innerHTML = `<div class="msg-content">
          <div class="ai-bubble error">${hint}</div>
        </div>`;
        msgs.appendChild(aiDiv);
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
  } catch {
    if (window.__setChatLoader) window.__setChatLoader(false);
    toast('❌ Ошибка соединения с сервером');
  }

  chatIsSending = false;
  if (sendBtn) { sendBtn.style.opacity = '1'; sendBtn.style.cursor = 'pointer'; }
  if (inputEl) inputEl.focus();
}

function startClaude() {
  if (ipcRenderer) {
    ipcRenderer.send('start-claude-bridge');
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupLogCapture();
  console.log('[INIT] Admin panel starting, session initialized');

  // Ping server status in footer
  setInterval(async () => {
    const start = Date.now();
    const ok = await api('/api/status');
    const latency = Date.now() - start;
    const el = document.getElementById('serverStatus');
    if (el) el.textContent = ok ? `Сервер онлайн · ${latency}мс` : 'Сервер недоступен';
  }, 5000);

  // Load initial data
  loadOverview();
});
