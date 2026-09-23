const { ipcRenderer } = require('electron');

// ── State ─────────────────────────────────────────────────
let isRunning = false;
let uptimeStart = null;
let uptimeInterval = null;

// ── Init ──────────────────────────────────────────────────
async function init() {
  await checkStatus();
  await loadNetworkInfo();
  startPolling();
}

// ── Check Server Status ───────────────────────────────────
async function checkStatus() {
  const result = await ipcRenderer.invoke('get-server-status');
  updateStatus(result.running);
}

function updateStatus(running) {
  isRunning = running;

  const ring = document.getElementById('statusRing');
  const icon = document.getElementById('statusIcon');
  const label = document.getElementById('statusLabel');
  const sublabel = document.getElementById('statusSublabel');
  const btn = document.getElementById('toggleBtn');
  const btnIcon = document.getElementById('toggleBtnIcon');
  const btnText = document.getElementById('toggleBtnText');

  ring.className = `status-ring ${running ? 'online' : 'offline'}`;
  icon.textContent = running ? '🟢' : '🔴';
  label.className = `status-label ${running ? 'online' : 'offline'}`;
  label.textContent = running ? 'Сервер запущен' : 'Сервер остановлен';
  sublabel.textContent = running
    ? 'Готов к подключениям'
    : 'Нажмите "Запустить" для старта';

  btn.className = `btn ${running ? 'btn-danger' : 'btn-primary'}`;
  btnIcon.textContent = running ? '⏹' : '▶';
  btnText.textContent = running ? 'Остановить' : 'Запустить';

  // Uptime
  if (running && !uptimeStart) {
    uptimeStart = Date.now();
    startUptimeCounter();
  } else if (!running) {
    uptimeStart = null;
    clearInterval(uptimeInterval);
    document.getElementById('uptime').textContent = '00:00:00';
  }

  // Load metrics if running
  if (running) {
    loadMetrics();
    loadOllamaStatus();
  } else {
    resetMetrics();
  }
}

// ── Toggle Server ─────────────────────────────────────────
async function toggleServer() {
  const btn = document.getElementById('toggleBtn');
  const btnText = document.getElementById('toggleBtnText');
  btn.disabled = true;
  btnText.textContent = isRunning ? 'Остановка...' : 'Запуск...';

  await ipcRenderer.invoke('toggle-server');

  // Re-check after 1s
  setTimeout(async () => {
    await checkStatus();
    btn.disabled = false;
  }, 1000);
}

// ── Network Info ──────────────────────────────────────────
async function loadNetworkInfo() {
  const interfaces = await ipcRenderer.invoke('get-network-info');
  const primary = interfaces[0];
  if (primary) {
    document.getElementById('ipAddress').textContent = primary.address;
    document.getElementById('fullAddress').textContent = `ws://${primary.address}:3000`;
  }
}

// ── Metrics ───────────────────────────────────────────────
async function loadMetrics() {
  const status = await ipcRenderer.invoke('fetch-api', '/api/status');
  if (!status) return;

  animateCounter('connections', status.activeConnections || 0);

  const metrics = await ipcRenderer.invoke('fetch-api', '/api/metrics');
  if (metrics) {
    animateCounter('requests', metrics.totalRequests || 0);
    animateCounter('errors', Math.round((metrics.errorRate || 0) * (metrics.totalRequests || 0)));
    document.getElementById('latency').textContent =
      metrics.averageResponseTime ? `${Math.round(metrics.averageResponseTime)}ms` : '—';
  }
}

function resetMetrics() {
  ['connections', 'requests', 'errors'].forEach(id => {
    document.getElementById(id).textContent = '0';
  });
  document.getElementById('latency').textContent = '—';
}

// ── Ollama Status ─────────────────────────────────────────
async function loadOllamaStatus() {
  const models = await ipcRenderer.invoke('fetch-api', '/api/models');
  const statusEl = document.getElementById('ollamaStatus');
  const modelEl = document.getElementById('modelName');
  const labelEl = document.getElementById('modelLabel');

  if (models && Array.isArray(models) && models.length > 0) {
    statusEl.className = 'badge badge-green';
    statusEl.textContent = '✓ Доступен';
    modelEl.textContent = models[0].name || 'Ollama';
    labelEl.textContent = `${models.length} модел${models.length === 1 ? 'ь' : 'и'} загружено`;
  } else if (models !== null) {
    statusEl.className = 'badge badge-orange';
    statusEl.textContent = '⚠ Нет моделей';
    modelEl.textContent = 'Ollama';
    labelEl.textContent = 'Скачайте модель через CLI';
  } else {
    statusEl.className = 'badge badge-red';
    statusEl.textContent = '✕ Недоступен';
    modelEl.textContent = 'Ollama';
    labelEl.textContent = 'Запустите Ollama на ПК';
  }
}

// ── Uptime Counter ────────────────────────────────────────
function startUptimeCounter() {
  clearInterval(uptimeInterval);
  uptimeInterval = setInterval(() => {
    if (!uptimeStart) return;
    const elapsed = Math.floor((Date.now() - uptimeStart) / 1000);
    const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
    const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    document.getElementById('uptime').textContent = `${h}:${m}:${s}`;
  }, 1000);
}

// ── Animated Counter ──────────────────────────────────────
function animateCounter(id, target) {
  const el = document.getElementById(id);
  const current = parseInt(el.textContent) || 0;
  const diff = target - current;
  if (diff === 0) return;

  const steps = 20;
  const step = diff / steps;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    const val = Math.round(current + step * i);
    el.textContent = val;
    if (i >= steps) {
      el.textContent = target;
      clearInterval(timer);
    }
  }, 16);
}

// ── Polling ───────────────────────────────────────────────
function startPolling() {
  setInterval(async () => {
    await checkStatus();
  }, 5000);
}

// ── IPC Events ────────────────────────────────────────────
ipcRenderer.on('server-status', (_, { running }) => {
  updateStatus(running);
});

// ── Actions ───────────────────────────────────────────────
function openAdmin() {
  ipcRenderer.invoke('open-admin');
}

function openSettings() {
  ipcRenderer.invoke('open-settings');
}

function minimize() {
  ipcRenderer.invoke('minimize-window');
}

function closeWindow() {
  ipcRenderer.invoke('close-window');
}

function copyAddress() {
  const addr = document.getElementById('fullAddress').textContent;
  navigator.clipboard.writeText(addr).then(() => {
    const btn = event.target;
    btn.textContent = '✓';
    setTimeout(() => btn.textContent = '⎘', 1500);
  });
}

function showQR() {
  // Simple QR display notification
  const addr = document.getElementById('fullAddress').textContent;
  alert(`Адрес для подключения:\n${addr}\n\nСкопируйте и введите в мобильном приложении`);
}

// ── Start ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
