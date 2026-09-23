/* vpn-core.js — разбор подписки и сборка конфига для движка Xray.
 *
 * Это то же, что делают Happ и Shadowrocket внутри: берут ссылку/подписку,
 * достают из неё серверы и превращают каждый в outbound-конфиг для Xray-core.
 * Сам движок трафик и гонит; здесь — только текст, поэтому всё проверяется
 * тестами без Windows и без самого движка.
 *
 * Работает и в браузере (кладёт себя в window.VpnCore для интерфейса), и в
 * Node (в main-процессе Electron, который пишет конфиг движку) — один и тот же
 * разбор, чтобы список в окне и то, что реально запускается, не разъезжались.
 */
(function (root) {
  'use strict';

  /* ── base64, терпимый к URL-варианту и отсутствию паддинга ──────────────── */
  function b64decode(str) {
    let s = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    try {
      if (typeof atob === 'function') return decodeURIComponent(escape(atob(s)));
      return Buffer.from(s, 'base64').toString('utf8');
    } catch {
      try {
        return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
      } catch {
        return '';
      }
    }
  }

  function looksBase64(str) {
    const s = String(str).trim();
    // Подписка обычно приходит одним base64-блоком без переносов и пробелов.
    return s.length > 24 && /^[A-Za-z0-9+/=_-]+\s*$/.test(s) && !s.includes('://');
  }

  /* ── разбор одной ссылки ────────────────────────────────────────────────── */

  /** vless://uuid@host:port?params#name */
  function parseVless(uri) {
    const u = new URL(uri);
    const q = u.searchParams;
    return {
      protocol: 'vless',
      name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
      id: decodeURIComponent(u.username),
      host: u.hostname,
      port: Number(u.port) || 443,
      network: q.get('type') || 'tcp',
      security: q.get('security') || 'none',
      sni: q.get('sni') || q.get('peer') || '',
      flow: q.get('flow') || '',
      pbk: q.get('pbk') || '',          // Reality public key
      sid: q.get('sid') || '',          // Reality short id
      fp: q.get('fp') || '',            // TLS fingerprint
      path: q.get('path') || '',
      hostHeader: q.get('host') || '',
      alpn: q.get('alpn') || '',
      raw: uri,
    };
  }

  /** trojan://password@host:port?params#name */
  function parseTrojan(uri) {
    const u = new URL(uri);
    const q = u.searchParams;
    return {
      protocol: 'trojan',
      name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
      password: decodeURIComponent(u.username),
      host: u.hostname,
      port: Number(u.port) || 443,
      network: q.get('type') || 'tcp',
      security: q.get('security') || 'tls',
      sni: q.get('sni') || q.get('peer') || '',
      alpn: q.get('alpn') || '',
      path: q.get('path') || '',
      hostHeader: q.get('host') || '',
      raw: uri,
    };
  }

  /** vmess://<base64 json> */
  function parseVmess(uri) {
    const json = b64decode(uri.slice('vmess://'.length));
    let o;
    try { o = JSON.parse(json); } catch { return null; }
    return {
      protocol: 'vmess',
      name: o.ps || o.add,
      id: o.id,
      host: o.add,
      port: Number(o.port) || 443,
      alterId: Number(o.aid) || 0,
      network: o.net || 'tcp',
      security: o.tls ? 'tls' : 'none',
      sni: o.sni || o.host || '',
      path: o.path || '',
      hostHeader: o.host || '',
      alpn: o.alpn || '',
      raw: uri,
    };
  }

  /** ss://<base64 method:pass>@host:port#name  или  ss://<base64 всего>#name */
  function parseShadowsocks(uri) {
    const hash = uri.indexOf('#');
    const name = hash >= 0 ? decodeURIComponent(uri.slice(hash + 1)) : '';
    let body = (hash >= 0 ? uri.slice(0, hash) : uri).slice('ss://'.length);

    let method, password, host, port;
    if (body.includes('@')) {
      const [cred, hostPart] = body.split('@');
      const dec = cred.includes(':') ? cred : b64decode(cred);
      [method, password] = dec.split(':');
      const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(hostPart);
      if (m) { host = m[1]; port = Number(m[2]); }
    } else {
      const dec = b64decode(body);
      const m = /^(.+?):(.+)@\[?([^\]]+)\]?:(\d+)$/.exec(dec);
      if (m) { method = m[1]; password = m[2]; host = m[3]; port = Number(m[4]); }
    }
    if (!host || !port) return null;
    return { protocol: 'shadowsocks', name: name || host, method, password, host, port, raw: uri };
  }

  function parseLink(uri) {
    const s = String(uri).trim();
    try {
      if (s.startsWith('vless://')) return parseVless(s);
      if (s.startsWith('trojan://')) return parseTrojan(s);
      if (s.startsWith('vmess://')) return parseVmess(s);
      if (s.startsWith('ss://')) return parseShadowsocks(s);
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Разбирает подписку целиком: либо один base64-блок (обычный формат), либо
   * просто список ссылок по строкам. Возвращает массив узлов; мусорные строки
   * молча пропускаются, а не роняют весь разбор.
   */
  function parseSubscription(text) {
    let body = String(text || '').trim();
    if (!body) return [];
    if (looksBase64(body)) {
      const decoded = b64decode(body);
      if (decoded) body = decoded;
    }
    const out = [];
    const seen = new Set();
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('//')) continue;
      const node = parseLink(t);
      if (node && node.host && node.port && !seen.has(node.raw)) {
        seen.add(node.raw);
        out.push(node);
      }
    }
    return out;
  }

  /* ── сборка конфига Xray ────────────────────────────────────────────────── */

  function streamSettings(n) {
    const ss = { network: n.network || 'tcp', security: n.security === 'reality' || n.pbk ? 'reality' : n.security || 'none' };

    if (ss.security === 'tls') {
      ss.tlsSettings = { serverName: n.sni || n.host, allowInsecure: false };
      if (n.alpn) ss.tlsSettings.alpn = n.alpn.split(',');
      if (n.fp) ss.tlsSettings.fingerprint = n.fp;
    } else if (ss.security === 'reality') {
      ss.realitySettings = {
        serverName: n.sni || n.host,
        publicKey: n.pbk,
        shortId: n.sid || '',
        fingerprint: n.fp || 'chrome',
      };
    }

    if (ss.network === 'ws') {
      ss.wsSettings = { path: n.path || '/', headers: n.hostHeader ? { Host: n.hostHeader } : {} };
    } else if (ss.network === 'grpc') {
      ss.grpcSettings = { serviceName: n.path || '' };
    }
    return ss;
  }

  function outbound(n) {
    if (n.protocol === 'vless') {
      const user = { id: n.id, encryption: 'none' };
      if (n.flow) user.flow = n.flow;
      return {
        protocol: 'vless',
        settings: { vnext: [{ address: n.host, port: n.port, users: [user] }] },
        streamSettings: streamSettings(n),
        tag: 'proxy',
      };
    }
    if (n.protocol === 'vmess') {
      return {
        protocol: 'vmess',
        settings: { vnext: [{ address: n.host, port: n.port, users: [{ id: n.id, alterId: n.alterId || 0, security: 'auto' }] }] },
        streamSettings: streamSettings(n),
        tag: 'proxy',
      };
    }
    if (n.protocol === 'trojan') {
      return {
        protocol: 'trojan',
        settings: { servers: [{ address: n.host, port: n.port, password: n.password }] },
        streamSettings: streamSettings(n),
        tag: 'proxy',
      };
    }
    if (n.protocol === 'shadowsocks') {
      return {
        protocol: 'shadowsocks',
        settings: { servers: [{ address: n.host, port: n.port, method: n.method, password: n.password }] },
        tag: 'proxy',
      };
    }
    return null;
  }

  /**
   * Полный конфиг Xray для одного узла.
   *
   * Поднимает локальные входы SOCKS и HTTP — именно на них потом переключается
   * система в режиме прокси. Порты задаёт вызывающий, чтобы не столкнуться с
   * занятыми.
   */
  function buildConfig(node, opts) {
    const o = opts || {};
    const socksPort = o.socksPort || 10808;
    const httpPort = o.httpPort || 10809;
    const out = outbound(node);
    if (!out) return null;
    return {
      log: { loglevel: 'warning' },
      inbounds: [
        { tag: 'socks', port: socksPort, listen: '127.0.0.1', protocol: 'socks',
          settings: { udp: true }, sniffing: { enabled: true, destOverride: ['http', 'tls'] } },
        { tag: 'http', port: httpPort, listen: '127.0.0.1', protocol: 'http' },
      ],
      outbounds: [
        out,
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
      ],
    };
  }

  root.VpnCore = { parseLink, parseSubscription, buildConfig, b64decode, looksBase64 };
  // В Node (main-процесс Electron) файл подключается через require — отдаём API.
  if (typeof module !== 'undefined' && module.exports) module.exports = root.VpnCore;
})(typeof window !== 'undefined' ? window : globalThis);
