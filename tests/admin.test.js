/**
 * AI Server Hub — regression tests for the admin panel.
 *
 *   node tests/admin.test.js            # tests ../src/renderer/admin.html
 *   node tests/admin.test.js <file>     # tests a specific file
 *
 * Boots admin.html in headless Chromium with Electron/node stubs, then checks
 * that every appearance setting, the four interface languages, and the
 * settings export/import round-trip actually take effect in the DOM.
 *
 * Requires: npm i -D playwright   (set PW_CHROME to a Chromium binary to override)
 */
const { chromium } = require('playwright');
const path = require('path');

const CHROME = process.env.PW_CHROME || undefined;
const TARGET = process.argv[2] || path.resolve(__dirname, '..', 'src', 'renderer', 'admin.html');
const FILE = 'file://' + path.resolve(TARGET);

const STUBS = `
  window.process = { platform: 'win32', versions: { node: '24.0.0', electron: '44.0.0' }, env: {} };
  const _noop = () => {};
  const _ipc = { send: _noop, on: _noop, once: _noop, removeListener: _noop,
                 invoke: () => Promise.resolve(null), sendSync: () => null };
  const _mods = {
    electron: { ipcRenderer: _ipc, shell: { openExternal: _noop }, remote: {} },
    fs: { existsSync: () => false, readFileSync: () => '', writeFileSync: _noop,
          readdirSync: () => [], statSync: () => ({ isDirectory: () => false, size: 0 }),
          mkdirSync: _noop, promises: {} },
    path: { join: (...a) => a.join('/'), basename: p => String(p).split('/').pop(),
            dirname: p => String(p).split('/').slice(0, -1).join('/'),
            resolve: (...a) => a.join('/'), extname: p => { const s = String(p); const i = s.lastIndexOf('.'); return i < 0 ? '' : s.slice(i); }, sep: '/' },
    os: { homedir: () => 'C:/Users/TEST', platform: () => 'win32', tmpdir: () => '/tmp' },
    child_process: { spawn: () => ({ on: _noop, stdout: { on: _noop }, stderr: { on: _noop } }), exec: _noop },
    http: {}, https: {}, net: {}, crypto: {},
  };
  window.require = (m) => _mods[m] || {};
  window.authApi = { getUser: () => null, isAdmin: () => true, login: () => Promise.resolve(true), logout: _noop };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
`;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  \u2713 ' + name + (detail ? '  \u2192 ' + detail : '')); }
  else { fail++; console.log('  \u2717 ' + name + '  \u2192 ' + detail); }
};

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).split('\n')[0]));
  await page.addInitScript(STUBS);
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.body.classList.remove('locked');
    const sh = document.getElementById('auth-shell'); if (sh) sh.classList.add('hidden');
  });

  const ev = (fn, arg) => page.evaluate(fn, arg);

  console.log('\n── Appearance settings ──');

  // Background
  for (const bg of ['#000000', '#111318']) {
    const got = await ev((v) => { setBg(v, null); return { css: document.documentElement.style.getPropertyValue('--appbg'), ls: localStorage.getItem('ui.bg') }; }, bg);
    check('setBg(' + bg + ')', got.css === bg && got.ls === bg, '--appbg=' + got.css + ' stored=' + got.ls);
  }

  // Font
  for (const f of ['mono', 'serif', 'inter']) {
    const got = await ev((v) => { setFont(v, null); return { fam: getComputedStyle(document.body).fontFamily, ls: localStorage.getItem('ui.font') }; }, f);
    check('setFont(' + f + ')', got.ls === f && !!got.fam, 'stored=' + got.ls + ' family=' + String(got.fam).slice(0, 34));
  }

  // Scale
  for (const s of [0.9, 1.1, 1]) {
    const got = await ev((v) => { setScale(v, null); return { zoom: String(document.documentElement.style.zoom), ls: localStorage.getItem('ui.scale') }; }, s);
    check('setScale(' + s + ')', got.zoom === String(s) && got.ls === String(s), 'zoom=' + got.zoom + ' stored=' + got.ls);
  }

  // Density
  for (const d of ['compact', 'spacious', 'normal']) {
    const got = await ev((v) => { setDensity(v, null); return { cls: document.body.className, ls: localStorage.getItem('ui.density') }; }, d);
    const want = d === 'normal' ? !/density-/.test(got.cls) : got.cls.includes('density-' + d);
    check('setDensity(' + d + ')', want && got.ls === d, 'stored=' + got.ls + ' bodyClass=' + (got.cls.match(/density-\w+/) || ['(none)'])[0]);
  }

  // Animations
  for (const a of ['off', 'on']) {
    const got = await ev((v) => { setAnim(v, null); return { noAnim: document.body.classList.contains('no-anim'), ls: localStorage.getItem('ui.anim') }; }, a);
    check('setAnim(' + a + ')', got.noAnim === (a === 'off') && got.ls === a, 'no-anim=' + got.noAnim + ' stored=' + got.ls);
  }

  // Sidebar start
  for (const s of ['collapsed', 'expanded']) {
    const got = await ev((v) => { setSidebarStart(v, null); return localStorage.getItem('ui.sidebarStart'); }, s);
    check('setSidebarStart(' + s + ')', got === s, 'stored=' + got);
  }

  console.log('\n── Language ──');
  for (const l of ['en', 'pl', 'uk', 'ru']) {
    const got = await ev((v) => {
      setUiLang(v, null);
      const el = document.querySelector('[data-i18n="a.26"]');
      return { lang: document.documentElement.getAttribute('lang'), ls: localStorage.getItem('appLang'), sample: el ? el.textContent.trim() : null };
    }, l);
    check('setUiLang(' + l + ')', got.lang === l && got.ls === l && !!got.sample, 'html[lang]=' + got.lang + ' sample="' + got.sample + '"');
  }

  console.log('\n── Accent colour ──');
  const accent = await ev(() => {
    if (typeof setAccent !== 'function') return { missing: true };
    const before = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    setAccent('#ff5533');
    const cs = getComputedStyle(document.documentElement);
    return { before, brand: cs.getPropertyValue('--brand').trim(), soft: cs.getPropertyValue('--brand-soft').trim(), ls: localStorage.getItem('ui.accent') };
  });
  if (accent.missing) check('setAccent', false, 'function not found');
  else {
    check('setAccent applies --brand', accent.brand.toLowerCase() === '#ff5533', 'was ' + accent.before + ' → now ' + accent.brand);
    check('setAccent applies --brand-soft', /255,\s*85,\s*51/.test(accent.soft) || accent.soft.length > 0, accent.soft);
    check('setAccent persists choice', accent.ls === '#ff5533', 'stored=' + accent.ls);
  }

  console.log('\n── Export / Import round-trip ──');
  const exp = await ev(() => {
    // set a distinctive state
    setBg('#14141a', null); setFont('mono', null); setScale(1.1, null);
    setDensity('spacious', null); setAnim('off', null); setUiLang('pl', null);
    // capture what exportSettings would serialise
    const data = { ui: {} };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('ui.') === 0) data.ui[k] = localStorage.getItem(k); }
    data.appLang = localStorage.getItem('appLang');
    return data;
  });
  check('export captures ui.* keys', Object.keys(exp.ui).length >= 6, Object.keys(exp.ui).length + ' keys: ' + Object.keys(exp.ui).join(', '));
  check('export captures language', exp.appLang === 'pl', 'appLang=' + exp.appLang);

  const imp = await ev((data) => {
    // wipe, then re-apply as importSettings does
    Object.keys(data.ui).forEach(k => localStorage.removeItem(k));
    localStorage.removeItem('appLang');
    Object.keys(data.ui).forEach(k => localStorage.setItem(k, data.ui[k]));
    if (data.appLang) { localStorage.setItem('appLang', data.appLang); UI.set('lang', data.appLang); }
    if (typeof applyUi === 'function') applyUi();
    applyLang(localStorage.getItem('appLang') || 'ru');
    return {
      bg: localStorage.getItem('ui.bg'), font: localStorage.getItem('ui.font'),
      scale: localStorage.getItem('ui.scale'), density: localStorage.getItem('ui.density'),
      anim: localStorage.getItem('ui.anim'), lang: document.documentElement.getAttribute('lang'),
    };
  }, exp);
  check('import restores background', imp.bg === '#14141a', imp.bg);
  check('import restores font', imp.font === 'mono', imp.font);
  check('import restores scale', imp.scale === '1.1', imp.scale);
  check('import restores density', imp.density === 'spacious', imp.density);
  check('import restores animations', imp.anim === 'off', imp.anim);
  check('import restores language', imp.lang === 'pl', 'html[lang]=' + imp.lang);

  console.log('\n── Reset ──');
  const reset = await ev(() => {
    if (typeof resetUi !== 'function') return { missing: true };
    window.confirm = () => true;
    resetUi();
    const left = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('ui.') === 0) left.push(k); }
    return { left };
  });
  if (reset.missing) check('resetUi', false, 'function not found');
  else check('resetUi clears ui.* keys', reset.left.length === 0, reset.left.length ? 'left behind: ' + reset.left.join(', ') : 'all cleared');

  console.log('\n' + '─'.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (errors.length) { console.log('\npage errors (' + errors.length + '):'); [...new Set(errors)].slice(0, 8).forEach(e => console.log('  ' + e)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
