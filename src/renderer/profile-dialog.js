/* profile-dialog.js — окно профиля администратора.
 *
 * Обычный скрипт, а не React: старое окно профиля живёт внутри собранного
 * бандла, исходников которого в проекте нет, — перекрасить его нечем.
 * Поэтому здесь новое окно в оформлении сайта, а пункт меню «Профиль»
 * перехватывается и открывает его. Старое остаётся в бандле нетронутым.
 *
 * Взяты только два блока сайта: данные профиля и настройки профиля.
 * Подписки и загрузок здесь нет — им место в своих разделах панели.
 *
 * Где живут данные. Почта приходит из auth.json через ipc — она задана при
 * регистрации и меняется не здесь. Остальное это оформление учётной записи на
 * этом компьютере, поэтому лежит там же, где язык и акцент панели (UI.*),
 * и работает, когда сервер выключен.
 */
'use strict';

(function () {
  const KEYS = { first: 'profile.first', last: 'profile.last', bio: 'profile.bio' };
  const MAX_BIO = 180;

  const get = (k, d) => (typeof UI !== 'undefined' ? UI.get(k, d) : d);
  const set = (k, v) => { if (typeof UI !== 'undefined') UI.set(k, v); };
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s));

  let el = null;          // корень окна
  let account = { email: null, username: 'admin' };

  /* ── данные ───────────────────────────────────────────────────────────── */

  async function loadAccount() {
    try {
      const st = await window.authApi?.status?.();
      if (st && st.email) account.email = st.email;
    } catch (e) { /* сервер и ipc недоступны — покажем прочерк */ }
    if (account.email) account.username = String(account.email).split('@')[0];
  }

  const profile = () => ({
    first: get(KEYS.first, 'Админ'),
    last: get(KEYS.last, ''),
    bio: get(KEYS.bio, ''),
  });

  function fullName(p) {
    const n = [p.first, p.last].filter(Boolean).join(' ').trim();
    return n || account.username || 'Админ';
  }

  const initial = (p) => (fullName(p).trim()[0] || 'A').toUpperCase();

  /* ── разметка ─────────────────────────────────────────────────────────── */

  function render() {
    const p = profile();
    return `
      <div class="pf-card" role="dialog" aria-modal="true" aria-label="Профиль">
        <div class="pf-top">
          <h2>Профиль</h2>
          <button class="pf-x" type="button" aria-label="Закрыть">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="pf-body">
          <div class="pf-ident">
            <div class="pf-avatar" id="pfAvatar">${esc(initial(p))}</div>
            <div class="pf-ident-txt">
              <div class="pf-name" id="pfName">${esc(fullName(p))}</div>
              <div class="pf-mail">${esc(account.email || 'почта не задана')}</div>
            </div>
          </div>

          <div class="pf-sec">
            <p class="pf-sec-t">Данные профиля</p>
            <p class="pf-sec-d">Заданы при регистрации на этом компьютере и меняются не здесь.</p>
          </div>
          <div class="pf-sep"></div>
          <div class="pf-fields">
            <div class="pf-field">
              <span class="pf-lbl">Имя пользователя</span>
              <div class="pf-ro">${esc(account.username || '—')}</div>
            </div>
            <div class="pf-field">
              <span class="pf-lbl">Email</span>
              <div class="pf-ro">${esc(account.email || '—')}</div>
            </div>
          </div>

          <div class="pf-sec pf-sec-gap">
            <p class="pf-sec-t">Настройки профиля</p>
            <p class="pf-sec-d">Как вас показывать в панели.</p>
          </div>
          <div class="pf-sep"></div>
          <div class="pf-grid">
            <div class="pf-field">
              <label class="pf-lbl" for="pfFirst">Имя</label>
              <input class="pf-in" id="pfFirst" maxlength="40" value="${esc(p.first)}">
            </div>
            <div class="pf-field">
              <label class="pf-lbl" for="pfLast">Фамилия</label>
              <input class="pf-in" id="pfLast" maxlength="40" placeholder="Фамилия" value="${esc(p.last)}">
            </div>
          </div>
          <div class="pf-field">
            <label class="pf-lbl" for="pfBio">О себе</label>
            <textarea class="pf-in pf-area" id="pfBio" maxlength="${MAX_BIO}" placeholder="Пара предложений о себе">${esc(p.bio)}</textarea>
            <div class="pf-count"><span id="pfLeft">${MAX_BIO - p.bio.length}</span> символов осталось</div>
          </div>
        </div>

        <div class="pf-foot">
          <button class="btn pf-cancel" type="button">Отмена</button>
          <button class="btn btn-primary pf-save" type="button">Сохранить</button>
        </div>
      </div>`;
  }

  /* ── поведение ────────────────────────────────────────────────────────── */

  function close() {
    if (!el) return;
    el.classList.remove('show');
    const node = el;
    el = null;
    setTimeout(() => node.remove(), 180);
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function save() {
    const first = document.getElementById('pfFirst').value.trim();
    const last = document.getElementById('pfLast').value.trim();
    const bio = document.getElementById('pfBio').value.trim();
    set(KEYS.first, first);
    set(KEYS.last, last);
    set(KEYS.bio, bio);
    if (typeof toast === 'function') toast('Профиль сохранён');
    close();
  }

  async function open() {
    if (el) return;
    await loadAccount();

    el = document.createElement('div');
    el.className = 'pf-overlay';
    el.innerHTML = render();
    document.body.appendChild(el);
    // Кадр на вставку в DOM, иначе переход не проигрывается.
    requestAnimationFrame(() => el && el.classList.add('show'));

    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    el.querySelector('.pf-x').addEventListener('click', close);
    el.querySelector('.pf-cancel').addEventListener('click', close);
    el.querySelector('.pf-save').addEventListener('click', save);
    document.addEventListener('keydown', onKey);

    // Имя и буква на аватаре обновляются на лету, как на сайте.
    const sync = () => {
      const p = {
        first: document.getElementById('pfFirst').value,
        last: document.getElementById('pfLast').value,
        bio: document.getElementById('pfBio').value,
      };
      document.getElementById('pfName').textContent = fullName(p);
      document.getElementById('pfAvatar').textContent = initial(p);
      document.getElementById('pfLeft').textContent = String(MAX_BIO - p.bio.length);
    };
    ['pfFirst', 'pfLast', 'pfBio'].forEach((id) =>
      document.getElementById(id).addEventListener('input', sync));

    document.getElementById('pfFirst').focus();
  }

  window.openProfileDialog = open;

  /* ── перехват пункта меню ─────────────────────────────────────────────────
     Меню рисует собранный бандл, дописать туда обработчик нельзя. Слушаем на
     стадии погружения: document получает событие раньше, чем React со своего
     корня, поэтому клик до старого окна не доходит. Если пункт когда-нибудь
     переименуют, перехват просто не сработает и откроется прежнее окно —
     сломать этим ничего нельзя. */
  document.addEventListener('click', function (e) {
    const node = e.target instanceof Element ? e.target.closest('div,button,a,span') : null;
    if (!node) return;
    if (!node.closest('#admin-nav-root')) return;
    if ((node.textContent || '').trim() !== 'Профиль') return;
    e.preventDefault();
    e.stopPropagation();
    open();
  }, true);
})();
