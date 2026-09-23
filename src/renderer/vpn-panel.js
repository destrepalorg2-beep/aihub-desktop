/* vpn-panel.js — раздел «VPN и серверы».
 *
 * Обычный скрипт, как и весь остальной admin-renderer: собранный React-бандл
 * трогать нельзя — часть его исходников в проекте потеряна, и пересборка
 * выбивает боковое меню и экран входа. Поэтому глобус и список серверов
 * сделаны здесь, на том же ванильном JS, что и прочие разделы.
 *
 * Глобус рисует cobe (vendor/cobe.js кладёт createGlobe в window).
 * Данные приходят из GET /api/admin/vpn/servers — сервер сам пингует хосты.
 */
'use strict';

(function () {
  const POLL_MS = 15000;

  let globe = null;          // текущий экземпляр cobe
  let rafId = 0;
  let phi = 0;
  let pollTimer = 0;
  let lastKey = '';          // по какому набору серверов построен глобус
  let lastData = null;       // последний удачный ответ — чтобы не мигать пустотой
  let dragging = null;
  let offset = { phi: 0, theta: 0 };
  let drag = { phi: 0, theta: 0 };

  const $ = (id) => document.getElementById(id);
  const tr = (k) => (typeof t === 'function' ? t(k) : k);

  /* ── Цвета ────────────────────────────────────────────────────────────────
     Компонент cobe по умолчанию рисует белый шар. Панель тёмная, поэтому
     основа затемнена, а маркеры берут акцент приложения — чёрные на тёмном
     просто исчезли бы. */
  function accentRgb() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(raw);
    if (!m) return [0.48, 0.46, 1];
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* ── Вспомогательное ──────────────────────────────────────────────────── */

  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s));

  /** Зелёный до 100 мс, жёлтый до 250, дальше красный — обычное чтение пинга. */
  function pingClass(ms) {
    if (ms === null || ms === undefined) return 'vpn-ping-none';
    if (ms < 100) return 'vpn-ping-good';
    if (ms < 250) return 'vpn-ping-ok';
    return 'vpn-ping-bad';
  }

  /** 0 мс — полная полоса, 400 мс — пустая. Минимум оставлен видимым. */
  function pingWidth(ms) {
    if (ms === null || ms === undefined) return 0;
    return Math.max(4, Math.min(100, Math.round(100 - (ms / 400) * 100)));
  }

  function hhmm(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ── Глобус ───────────────────────────────────────────────────────────── */

  function destroyGlobe() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (globe) { try { globe.destroy(); } catch (e) {} }
    globe = null;
    lastKey = '';
  }

  function buildGlobe(servers) {
    const canvas = $('vpnGlobe');
    if (!canvas || typeof window.createGlobe !== 'function') return;

    // Пока раздел скрыт, ширина равна нулю и рисовать нечего. Построим, когда
    // его откроют, — за этим следит ResizeObserver ниже.
    const width = canvas.offsetWidth;
    if (!width) return;

    const key = servers.map((s) => s.id + ':' + s.location.join(',')).join('|');
    if (globe && key === lastKey) return;   // набор не менялся — не пересоздаём
    destroyGlobe();
    lastKey = key;
    if (!servers.length) return;

    const accent = accentRgb();
    const hub = servers[0];
    const arcs = servers.slice(1).map((s) => ({
      id: hub.id + '-' + s.id,
      from: hub.location,
      to: s.location,
    }));

    globe = window.createGlobe(canvas, {
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      width: width, height: width,
      phi: 0, theta: 0.2, dark: 1, diffuse: 1.4,
      mapSamples: 16000, mapBrightness: 6,
      baseColor: [0.16, 0.16, 0.22],
      markerColor: accent,
      glowColor: [0.12, 0.12, 0.18],
      markerElevation: 0.02,
      markers: servers.map((s) => ({ location: s.location, size: 0.012, id: s.id })),
      arcs: arcs,
      arcColor: accent,
      arcWidth: 0.5, arcHeight: 0.25, opacity: 0.7,
    });

    (function animate() {
      if (!dragging) phi += 0.003;
      globe.update({
        phi: phi + offset.phi + drag.phi,
        theta: 0.2 + offset.theta + drag.theta,
      });
      rafId = requestAnimationFrame(animate);
    })();

    canvas.style.opacity = '1';
  }

  /** Подписи над маркерами и дугами. cobe проставляет якоря, CSS их ловит. */
  function renderGlobeLabels(servers) {
    const host = $('vpnLabels');
    if (!host) return;
    const hub = servers[0];

    const marks = servers.map((s) =>
      '<div class="vpn-lab" style="position-anchor:--cobe-' + esc(s.id) + ';' +
      'opacity:var(--cobe-visible-' + esc(s.id) + ',0);' +
      'filter:blur(calc((1 - var(--cobe-visible-' + esc(s.id) + ',0)) * 8px))">' +
      '<span class="vpn-lab-dot' + (s.online ? ' on' : '') + '"></span>' +
      '<span class="vpn-lab-txt">' + esc(s.region) + '</span></div>'
    ).join('');

    const arcs = servers.slice(1).map(function (s) {
      const id = hub.id + '-' + s.id;
      const text = s.latencyMs != null ? s.latencyMs + ' мс' : '—';
      return '<div class="vpn-arclab" style="position-anchor:--cobe-arc-' + esc(id) + ';' +
        'opacity:var(--cobe-visible-arc-' + esc(id) + ',0);' +
        'filter:blur(calc((1 - var(--cobe-visible-arc-' + esc(id) + ',0)) * 8px))">' +
        esc(text) + '</div>';
    }).join('');

    host.innerHTML = marks + arcs;
  }

  /* ── Перетаскивание ───────────────────────────────────────────────────── */

  function initDrag() {
    const canvas = $('vpnGlobe');
    if (!canvas || canvas.dataset.drag === '1') return;
    canvas.dataset.drag = '1';

    canvas.addEventListener('pointerdown', (e) => {
      dragging = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      drag = { phi: (e.clientX - dragging.x) / 300, theta: (e.clientY - dragging.y) / 1000 };
    }, { passive: true });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      offset.phi += drag.phi;
      offset.theta += drag.theta;
      drag = { phi: 0, theta: 0 };
      dragging = null;
      canvas.style.cursor = 'grab';
    }, { passive: true });
  }

  /* ── Отрисовка ────────────────────────────────────────────────────────── */

  function render(data, stale) {
    const servers = (data && data.servers) || [];

    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const online = servers.filter((s) => s.online).length;
    let best = null;
    servers.forEach((s) => {
      if (s.online && s.latencyMs != null && (!best || s.latencyMs < best.latencyMs)) best = s;
    });

    set('vpnTotal', servers.length || '—');
    set('vpnOnline', servers.length ? online + ' из ' + servers.length : '—');
    set('vpnBest', best ? best.latencyMs + ' мс' : '—');
    set('vpnBestName', best ? best.name : '');
    set('vpnChecked', data && data.checkedAt ? hhmm(data.checkedAt) : '—');
    // «Устарели» — только если когда-то были свежие. На первом же неудачном
    // опросе устаревать ещё нечему, там просто нет связи.
    set('vpnCheckedSub', stale ? (data ? 'данные устарели' : 'нет связи') : '');

    const onlineEl = $('vpnOnline');
    if (onlineEl) {
      onlineEl.classList.toggle('vpn-ok', servers.length > 0 && online > 0);
      onlineEl.classList.toggle('vpn-bad', servers.length > 0 && online === 0);
    }

    const body = $('vpnList');
    const empty = $('vpnEmpty');
    if (!servers.length) {
      if (body) body.innerHTML = '';
      if (empty) {
        empty.style.display = '';
        // Три разных случая, и путать их нельзя: «сервер не ответил» это не то
        // же самое, что «серверов нет». Раньше на обрыв связи писалось «Список
        // пуст», и выходило, что панель врёт про пустой список, которого она
        // даже не запрашивала.
        if (!data) {
          empty.innerHTML =
            '<b>Нет связи с AI-сервером.</b><br>' +
            'Список серверов отдаёт он, на порту 3000. Запустите его — и раздел заполнится сам.';
        } else if (!data.configured) {
          empty.innerHTML =
            'Серверы не заданы. Скопируйте <code>data/vpn-servers.example.json</code> в ' +
            '<code>' + esc(data.configPath || 'data/vpn-servers.json') + '</code> ' +
            'и впишите адреса — координаты и названия там уже проставлены.';
        } else {
          empty.innerHTML = 'Список пуст.';
        }
      }
      destroyGlobe();
      const labels = $('vpnLabels');
      if (labels) labels.innerHTML = '';
      const mapNote = $('vpnMapEmpty');
      if (mapNote) {
        mapNote.style.display = '';
        mapNote.textContent = data
          ? 'Глобус покажет серверы, как только появятся адреса.'
          : 'Нет связи с AI-сервером.';
      }
      return;
    }
    if (empty) empty.style.display = 'none';
    const mapNote = $('vpnMapEmpty');
    if (mapNote) mapNote.style.display = 'none';

    if (body) {
      body.innerHTML = servers.map(function (s) {
        const ms = s.latencyMs;
        return '<tr class="row">' +
          '<td><span class="vpn-dot' + (s.online ? ' on' : '') + '" title="' +
            esc(s.online ? 'на связи' : (s.error || 'не отвечает')) + '"></span></td>' +
          '<td><div class="vpn-name">' + esc(s.name) + '</div>' +
              '<div class="vpn-host">' + esc(s.host || 'адрес не указан') +
              (s.host ? ':' + esc(s.port) : '') + (s.protocol ? ' · ' + esc(s.protocol) : '') + '</div></td>' +
          '<td class="vpn-region">' + esc(s.region) + '</td>' +
          '<td><div class="vpn-bar"><i style="width:' + pingWidth(ms) + '%"></i></div></td>' +
          '<td class="vpn-ping ' + pingClass(ms) + '">' +
            (s.online && ms != null ? ms + '<span>мс</span>' : '—') + '</td>' +
        '</tr>';
      }).join('');
    }

    buildGlobe(servers);
    renderGlobeLabels(servers);
    initDrag();
  }

  /* ── Данные ───────────────────────────────────────────────────────────── */

  async function fetchOnce() {
    const btn = $('vpnRefresh');
    if (btn) { btn.disabled = true; btn.textContent = 'Проверяю…'; }
    try {
      const data = await api('/api/admin/vpn/servers');
      if (data) {
        lastData = data;
        render(data, false);
      } else {
        // Оставляем последние показания и помечаем их устаревшими — мигать
        // пустотой при каждом неудачном опросе хуже, чем показать старое.
        render(lastData, true);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Проверить сейчас'; }
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (window.__currentView === 'vpn') fetchOnce();
      else stopPolling();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }

  /* ── Точка входа, её зовёт setView ────────────────────────────────────── */

  window.loadVpnPage = function () {
    // Первый заход: показать анимацию загрузки, пока сервер обходит хосты —
    // на восьми серверах с таймаутом это несколько секунд пустого экрана.
    const empty = $('vpnEmpty');
    if (empty && !lastData && typeof loaderHtml === 'function') {
      empty.style.display = '';
      empty.innerHTML = loaderHtml('Проверяю серверы…');
    }

    fetchOnce();
    startPolling();

    // Раздел открывается скрытым, у канваса нулевая ширина. Строим глобус,
    // как только ширина появится.
    const canvas = $('vpnGlobe');
    if (canvas && !canvas.dataset.ro) {
      canvas.dataset.ro = '1';
      const ro = new ResizeObserver(function (entries) {
        if (entries[0] && entries[0].contentRect.width > 0 && lastData) {
          buildGlobe(lastData.servers || []);
        }
      });
      ro.observe(canvas);
    }
  };

  window.vpnRefresh = fetchOnce;
})();
