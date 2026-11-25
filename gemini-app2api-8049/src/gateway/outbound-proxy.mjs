/** Zero-dependency outbound HTTP(S) & SOCKS5 proxy helper for Node HTTP/2 and HTTPS fetch.
 * Respects HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, NO_PROXY, and Windows system proxy without logging credentials.
 */
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Duplex, Readable } from 'node:stream';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const WIN_PROXY_CACHE_TTL_MS = 5_000;
const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

let winProxyCache = null;

export function clearWindowsSystemProxyCache() {
  winProxyCache = null;
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function defaultPort(protocol) {
  if (protocol === 'https:') return '443';
  if (protocol === 'socks5:' || protocol === 'socks5h:') return '1080';
  return '80';
}

function isBypassed(target, noProxyRaw) {
  if (typeof noProxyRaw !== 'string' || !noProxyRaw.trim()) return false;
  const host = stripBrackets(target.hostname).toLowerCase();
  const port = target.port || defaultPort(target.protocol);
  for (const rawEntry of noProxyRaw.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort = null;
    if (entry.startsWith('[')) {
      const end = entry.indexOf(']');
      if (end < 0) continue;
      entryHost = entry.slice(1, end);
      if (entry[end + 1] === ':') entryPort = entry.slice(end + 2);
    } else {
      const colon = entry.lastIndexOf(':');
      if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
        entryHost = entry.slice(0, colon);
        entryPort = entry.slice(colon + 1);
      }
    }
    if (entryPort && entryPort !== port) continue;
    const normalized = entryHost.startsWith('.') ? entryHost.slice(1) : entryHost;
    if (!normalized) continue;
    if (host === normalized || host.endsWith('.' + normalized)) return true;
  }
  return false;
}

function isWindowsBypassed(target, proxyOverrideRaw) {
  if (typeof proxyOverrideRaw !== 'string' || !proxyOverrideRaw.trim()) return false;
  const entries = proxyOverrideRaw
    .split(/[;,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const host = stripBrackets(target.hostname).toLowerCase();
  const filtered = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (lower === '<local>') {
      if (!host.includes('.')) return true;
      continue;
    }
    if (lower.includes('*')) {
      const escaped = lower
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`, 'i').test(host)) return true;
      continue;
    }
    filtered.push(entry);
  }
  return filtered.length > 0 ? isBypassed(target, filtered.join(',')) : false;
}

export function parseWindowsProxyServer(proxyServerRaw, targetProtocol = 'https:') {
  if (typeof proxyServerRaw !== 'string') return null;
  const trimmed = proxyServerRaw.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;

  let candidate = '';
  if (trimmed.includes('=')) {
    const map = new Map();
    for (const part of trimmed.split(/[;\s]+/)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const scheme = part.slice(0, eq).trim().toLowerCase();
      const addr = part.slice(eq + 1).trim();
      if (scheme && addr && !map.has(scheme)) {
        map.set(scheme, addr);
      }
    }
    const order = targetProtocol === 'https:' ? ['https', 'http', 'socks'] : ['http', 'socks'];
    for (const key of order) {
      const val = map.get(key);
      if (!val) continue;
      if (val.includes('://')) {
        candidate = val;
      } else {
        candidate = key === 'socks' ? `socks5://${val}` : `http://${val}`;
      }
      break;
    }
  } else {
    candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  }

  if (!candidate || /[\r\n\0]/.test(candidate)) return null;
  let proxy;
  try {
    proxy = new URL(candidate);
  } catch {
    return null;
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(proxy.protocol) || !proxy.hostname) return null;
  return proxy;
}

export function readWindowsSystemProxy(env = process.env, opts = {}) {
  const useCache = !opts.spawnSync && !opts.now;
  const now = opts.now ?? Date.now();
  if (useCache && winProxyCache && now - winProxyCache.fetchedAt < WIN_PROXY_CACHE_TTL_MS) {
    return winProxyCache.value;
  }

  const systemRoot =
    (typeof env?.SystemRoot === 'string' && env.SystemRoot.trim()) ||
    (typeof env?.WINDIR === 'string' && env.WINDIR.trim()) ||
    'C:\\Windows';
  const regPath = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const spawnSyncImpl = opts.spawnSync ?? spawnSync;
  const res = spawnSyncImpl(
    regPath,
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );

  let value = { enabled: false, proxyServer: '', proxyOverride: '' };
  if (!res?.error && !res?.signal && res?.status === 0) {
    const out = res.stdout ?? '';
    const enableMatch = out.match(/^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/im);
    const serverMatch = out.match(/^\s*ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im);
    const overrideMatch = out.match(/^\s*ProxyOverride\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im);
    const enabled = enableMatch
      ? Number.parseInt(enableMatch[1], enableMatch[1].toLowerCase().startsWith('0x') ? 16 : 10) !== 0
      : false;
    value = {
      enabled,
      proxyServer: serverMatch ? serverMatch[1].trim() : '',
      proxyOverride: overrideMatch ? overrideMatch[1].trim() : '',
    };
  }

  if (useCache) {
    winProxyCache = { fetchedAt: now, value };
  }
  return value;
}

export function resolveOutboundProxy(targetUrl, env = process.env, opts = {}) {
  if (!env || typeof env !== 'object') return null;
  let target;
  try { target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl); } catch { return null; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (isBypassed(target, env.NO_PROXY ?? env.no_proxy ?? '')) return null;
  const raw = target.protocol === 'https:'
    ? (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || '')
    : (env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '');
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed) {
    if (/[\r\n\0]/.test(trimmed)) return null;
    let proxy;
    try { proxy = new URL(trimmed); } catch { return null; }
    if (!SUPPORTED_PROXY_PROTOCOLS.has(proxy.protocol) || !proxy.hostname) return null;
    return proxy;
  }

  const platform = opts.platform ?? process.platform;
  const allowWinFallback = env === process.env || opts.readWindowsSystemProxy === true || opts.allowWindowsSystemProxy === true;
  if (platform === 'win32' && allowWinFallback) {
    const winProxy = readWindowsSystemProxy(env, opts);
    if (winProxy.enabled && winProxy.proxyServer && !isWindowsBypassed(target, winProxy.proxyOverride)) {
      return parseWindowsProxyServer(winProxy.proxyServer, target.protocol);
    }
  }
  return null;
}

function formatAuthority(host, port) {
  const bare = stripBrackets(host);
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

function parseIpv6Bytes(ip) {
  let addr = stripBrackets(ip);
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx >= 0) addr = addr.slice(0, zoneIdx);
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const rightRaw = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];
  const expandHextets = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const seg = list[i];
      if (seg.includes('.') && i === list.length - 1) {
        const octets = seg.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        const val = Number.parseInt(seg, 16);
        if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
        out.push(val);
      }
    }
    return out;
  };
  const leftNums = expandHextets(left);
  const rightNums = expandHextets(rightRaw);
  if (!leftNums || !rightNums) return null;
  const missing = 8 - (leftNums.length + rightNums.length);
  if (parts.length === 1 && missing !== 0) return null;
  if (parts.length === 2 && missing < 0) return null;
  const all = parts.length === 2 ? [...leftNums, ...new Array(missing).fill(0), ...rightNums] : leftNums;
  if (all.length !== 8) return null;
  const buf = Buffer.allocUnsafe(16);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(all[i], i * 2);
  return buf;
}

function buildSocks5ConnectPacket(targetHost, targetPort) {
  const bare = stripBrackets(targetHost);
  const ipType = net.isIP(bare);
  const port = Number(targetPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SOCKS5_INVALID_PORT');
  }
  let addrPart;
  let atyp;
  if (ipType === 4) {
    atyp = 0x01;
    addrPart = Buffer.from(bare.split('.').map(Number));
  } else if (ipType === 6) {
    const v6 = parseIpv6Bytes(bare);
    if (!v6) throw new Error('SOCKS5_INVALID_IPV6');
    atyp = 0x04;
    addrPart = v6;
  } else {
    atyp = 0x03;
    const hostBuf = Buffer.from(bare, 'utf8');
    if (hostBuf.length === 0 || hostBuf.length > 255) {
      throw new Error('SOCKS5_INVALID_DOMAIN');
    }
    addrPart = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]);
  }
  const packet = Buffer.allocUnsafe(4 + addrPart.length + 2);
  packet[0] = 0x05;
  packet[1] = 0x01; // CONNECT
  packet[2] = 0x00; // RSV
  packet[3] = atyp;
  addrPart.copy(packet, 4);
  packet.writeUInt16BE(port, 4 + addrPart.length);
  return packet;
}

function createSocks5Tunnel(
  proxyUrl,
  targetHost,
  targetPort,
  { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, signal } = {},
) {
  let rawSocket = null;
  let connected = false;
  let finished = false;
  let finalCallback = null;
  const pendingWrites = [];

  const failPending = (err) => {
    while (pendingWrites.length) {
      const item = pendingWrites.shift();
      try { item.callback(err); } catch {}
    }
    if (finalCallback) {
      const cb = finalCallback;
      finalCallback = null;
      try { cb(err); } catch {}
    }
  };

  const tunnel = new Duplex({
    read() {
      rawSocket?.resume();
    },
    write(chunk, encoding, callback) {
      if (connected && rawSocket) {
        if (rawSocket.destroyed) { callback(new Error('PROXY_TUNNEL_CLOSED')); return; }
        rawSocket.write(chunk, encoding, callback);
        return;
      }
      pendingWrites.push({ chunk, encoding, callback });
    },
    final(callback) {
      finished = true;
      if (connected && rawSocket) {
        rawSocket.end(callback);
        return;
      }
      finalCallback = callback;
    },
    destroy(err, callback) {
      signal?.removeEventListener('abort', onAbort);
      try { rawSocket?.destroy(); } catch {}
      failPending(err || new Error('PROXY_TUNNEL_DESTROYED'));
      callback(err);
    },
  });

  const onAbort = () => tunnel.destroy(new Error('PROXY_CONNECT_ABORTED'));
  signal?.addEventListener('abort', onAbort, { once: true });

  const hasAuth = Boolean(proxyUrl.username || proxyUrl.password);
  const username = hasAuth ? decodeURIComponent(proxyUrl.username || '') : '';
  const password = hasAuth ? decodeURIComponent(proxyUrl.password || '') : '';
  const userBuf = hasAuth ? Buffer.from(username, 'utf8') : null;
  const passBuf = hasAuth ? Buffer.from(password, 'utf8') : null;
  if (hasAuth && (userBuf.length > 255 || passBuf.length > 255)) {
    queueMicrotask(() => {
      if (!tunnel.destroyed) tunnel.destroy(new Error('SOCKS5_CREDENTIALS_TOO_LONG'));
    });
    return tunnel;
  }

  let connectPacket;
  try {
    connectPacket = buildSocks5ConnectPacket(targetHost, targetPort);
  } catch (err) {
    queueMicrotask(() => {
      if (!tunnel.destroyed) tunnel.destroy(err);
    });
    return tunnel;
  }

  const proxyHost = stripBrackets(proxyUrl.hostname);
  const proxyPort = Number(proxyUrl.port) || 1080;
  const socket = net.connect({ host: proxyHost, port: proxyPort });
  rawSocket = socket;
  socket.setTimeout(timeoutMs);

  let phase = 'greeting';
  let handshakeBuf = Buffer.alloc(0);

  const failHandshake = (err) => {
    signal?.removeEventListener('abort', onAbort);
    socket.removeAllListeners('data');
    if (!tunnel.destroyed) tunnel.destroy(err);
  };

  const enterStreaming = (head) => {
    phase = 'streaming';
    signal?.removeEventListener('abort', onAbort);
    socket.setTimeout(0);
    socket.removeListener('data', onHandshakeData);
    socket.removeListener('end', onHandshakeEnd);
    if (tunnel.destroyed) {
      try { socket.destroy(); } catch {}
      return;
    }
    connected = true;
    try { socket.setKeepAlive?.(true, 15_000); } catch {}
    try { socket.setNoDelay?.(true); } catch {}
    socket.on('data', (chunk) => {
      if (!tunnel.destroyed && !tunnel.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      if (!tunnel.destroyed) tunnel.push(null);
    });
    if (head && head.length > 0 && !tunnel.push(head)) socket.pause();
    while (pendingWrites.length) {
      const item = pendingWrites.shift();
      socket.write(item.chunk, item.encoding, item.callback);
    }
    if (finished) {
      const cb = finalCallback;
      finalCallback = null;
      socket.end(cb || undefined);
    }
  };

  const onHandshakeEnd = () => {
    failHandshake(new Error('SOCKS5_PREMATURE_EOF'));
  };

  const onHandshakeData = (chunk) => {
    handshakeBuf = handshakeBuf.length > 0 ? Buffer.concat([handshakeBuf, chunk]) : chunk;
    if (phase === 'greeting') {
      if (handshakeBuf.length < 2) return;
      const ver = handshakeBuf[0];
      const method = handshakeBuf[1];
      handshakeBuf = handshakeBuf.subarray(2);
      if (ver !== 0x05) {
        failHandshake(new Error('SOCKS5_INVALID_VERSION'));
        return;
      }
      if (method === 0xff) {
        failHandshake(new Error('SOCKS5_NO_ACCEPTABLE_AUTH'));
        return;
      }
      if (method === 0x00) {
        phase = 'connect';
        socket.write(connectPacket);
      } else if (method === 0x02) {
        if (!hasAuth) {
          failHandshake(new Error('SOCKS5_AUTH_REQUIRED'));
          return;
        }
        phase = 'auth';
        const authPacket = Buffer.concat([
          Buffer.from([0x01, userBuf.length]),
          userBuf,
          Buffer.from([passBuf.length]),
          passBuf,
        ]);
        socket.write(authPacket);
      } else {
        failHandshake(new Error('SOCKS5_UNSUPPORTED_AUTH'));
        return;
      }
    }

    if (phase === 'auth') {
      if (handshakeBuf.length < 2) return;
      const ver = handshakeBuf[0];
      const status = handshakeBuf[1];
      handshakeBuf = handshakeBuf.subarray(2);
      if (ver !== 0x01 || status !== 0x00) {
        failHandshake(new Error('SOCKS5_AUTH_FAILED'));
        return;
      }
      phase = 'connect';
      socket.write(connectPacket);
    }

    if (phase === 'connect') {
      if (handshakeBuf.length < 4) return;
      const ver = handshakeBuf[0];
      const rep = handshakeBuf[1];
      const atyp = handshakeBuf[3];
      if (ver !== 0x05) {
        failHandshake(new Error('SOCKS5_INVALID_VERSION'));
        return;
      }
      let totalLen;
      if (atyp === 0x01) {
        totalLen = 10;
      } else if (atyp === 0x04) {
        totalLen = 22;
      } else if (atyp === 0x03) {
        if (handshakeBuf.length < 5) return;
        totalLen = 4 + 1 + handshakeBuf[4] + 2;
      } else {
        failHandshake(new Error('SOCKS5_INVALID_ATYP'));
        return;
      }
      if (handshakeBuf.length < totalLen) return;
      const head = handshakeBuf.subarray(totalLen);
      handshakeBuf = Buffer.alloc(0);
      if (rep !== 0x00) {
        failHandshake(new Error(`SOCKS5_CONNECT_FAILED_${rep}`));
        return;
      }
      enterStreaming(head);
    }
  };

  socket.once('connect', () => {
    if (tunnel.destroyed) return;
    const methods = hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00];
    socket.write(Buffer.from(methods));
  });
  socket.on('data', onHandshakeData);
  socket.once('end', onHandshakeEnd);
  socket.on('timeout', () => {
    if (!connected) failHandshake(new Error('PROXY_CONNECT_TIMEOUT'));
  });
  socket.on('error', (err) => {
    if (!tunnel.destroyed) tunnel.destroy(err);
  });
  socket.on('close', () => {
    if (!tunnel.destroyed) tunnel.destroy();
  });

  return tunnel;
}

export function createConnectTunnel(
  proxyUrl,
  targetHost,
  targetPort,
  { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, signal, rejectUnauthorized = true, ca } = {},
) {
  if (proxyUrl?.protocol === 'socks5:' || proxyUrl?.protocol === 'socks5h:') {
    return createSocks5Tunnel(proxyUrl, targetHost, targetPort, { timeoutMs, signal });
  }
  const authority = formatAuthority(targetHost, targetPort);
  const headers = { Host: authority };
  if (proxyUrl.username || proxyUrl.password) {
    const user = decodeURIComponent(proxyUrl.username || '');
    const pass = decodeURIComponent(proxyUrl.password || '');
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  }
  let rawSocket = null;
  let connected = false;
  let finished = false;
  let finalCallback = null;
  const pendingWrites = [];

  const failPending = (err) => {
    while (pendingWrites.length) {
      const item = pendingWrites.shift();
      try { item.callback(err); } catch {}
    }
    if (finalCallback) {
      const cb = finalCallback;
      finalCallback = null;
      try { cb(err); } catch {}
    }
  };

  const tunnel = new Duplex({
    read() {
      rawSocket?.resume();
    },
    write(chunk, encoding, callback) {
      if (connected && rawSocket) {
        if (rawSocket.destroyed) { callback(new Error('PROXY_TUNNEL_CLOSED')); return; }
        rawSocket.write(chunk, encoding, callback);
        return;
      }
      pendingWrites.push({ chunk, encoding, callback });
    },
    final(callback) {
      finished = true;
      if (connected && rawSocket) {
        rawSocket.end(callback);
        return;
      }
      finalCallback = callback;
    },
    destroy(err, callback) {
      signal?.removeEventListener('abort', onAbort);
      try { req.destroy(); } catch {}
      try { rawSocket?.destroy(); } catch {}
      failPending(err || new Error('PROXY_TUNNEL_DESTROYED'));
      callback(err);
    },
  });

  const onAbort = () => tunnel.destroy(new Error('PROXY_CONNECT_ABORTED'));
  signal?.addEventListener('abort', onAbort, { once: true });

  const transport = proxyUrl.protocol === 'https:' ? https : http;
  const req = transport.request({
    host: stripBrackets(proxyUrl.hostname),
    port: Number(proxyUrl.port) || Number(defaultPort(proxyUrl.protocol)),
    method: 'CONNECT',
    path: authority,
    headers,
    timeout: timeoutMs,
    ...(proxyUrl.protocol === 'https:' ? { rejectUnauthorized, ...(ca ? { ca } : {}) } : {}),
  });

  req.on('connect', (res, socket, head) => {
    signal?.removeEventListener('abort', onAbort);
    if (tunnel.destroyed) {
      try { socket.destroy(); } catch {}
      return;
    }
    if (res.statusCode !== 200) {
      try { socket.destroy(); } catch {}
      tunnel.destroy(new Error(`PROXY_CONNECT_REJECTED_${res.statusCode || 0}`));
      return;
    }
    rawSocket = socket;
    connected = true;
    try { socket.setKeepAlive?.(true, 15_000); } catch {}
    try { socket.setNoDelay?.(true); } catch {}
    socket.on('data', (chunk) => {
      if (!tunnel.destroyed && !tunnel.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      if (!tunnel.destroyed) tunnel.push(null);
    });
    socket.on('error', (err) => {
      if (!tunnel.destroyed) tunnel.destroy(err);
    });
    socket.on('close', () => {
      if (!tunnel.destroyed) tunnel.destroy();
    });
    if (head && head.length > 0 && !tunnel.push(head)) socket.pause();
    while (pendingWrites.length) {
      const item = pendingWrites.shift();
      socket.write(item.chunk, item.encoding, item.callback);
    }
    if (finished) {
      const cb = finalCallback;
      finalCallback = null;
      socket.end(cb || undefined);
    }
  });

  req.on('response', (res) => {
    res.resume();
    if (!tunnel.destroyed) tunnel.destroy(new Error(`PROXY_CONNECT_REJECTED_${res.statusCode || 0}`));
  });
  req.on('timeout', () => {
    req.destroy();
    if (!tunnel.destroyed) tunnel.destroy(new Error('PROXY_CONNECT_TIMEOUT'));
  });
  req.on('error', (err) => {
    if (!tunnel.destroyed) tunnel.destroy(err);
  });
  req.end();

  return tunnel;
}

export function connectHttp2(origin, options = {}, { env = process.env } = {}) {
  const proxyUrl = resolveOutboundProxy(origin, env);
  if (!proxyUrl) return http2.connect(origin, options);
  const target = origin instanceof URL ? origin : new URL(origin);
  if (target.protocol !== 'https:') return http2.connect(origin, options);
  const targetHost = stripBrackets(target.hostname);
  const targetPort = Number(target.port) || 443;
  return http2.connect(origin, {
    ...options,
    createConnection: () => {
      const tunnel = createConnectTunnel(proxyUrl, targetHost, targetPort, {
        rejectUnauthorized: options?.proxyRejectUnauthorized ?? true,
        ...(options?.proxyCa ? { ca: options.proxyCa } : {}),
      });
      return tls.connect({
        socket: tunnel,
        servername: net.isIP(targetHost) ? undefined : targetHost,
        ALPNProtocols: ['h2'],
        rejectUnauthorized: options?.rejectUnauthorized ?? true,
        ...(options?.ca ? { ca: options.ca } : {}),
      });
    },
  });
}

function normalizeRequestBody(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return Buffer.from(String(body), 'utf8');
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Cached keep-alive HTTPS agents: one for direct HTTPS and one per proxy + TLS config.
// Note: when no proxy is configured, fetchWithProxy delegates to `fetchImpl` (Node's
// built-in fetch/undici already pools keep-alive connections); `directHttpsAgent` is
// cached alongside per-proxy agents for callers or direct https.request paths.
let directHttpsAgent = null;
const proxyHttpsAgents = new Map();

function buildProxyAgentKey(proxyUrl, tlsOptions = {}) {
  const rejectUnauthorized = tlsOptions.rejectUnauthorized ?? true;
  const proxyRejectUnauthorized = tlsOptions.proxyRejectUnauthorized ?? true;
  return `${proxyUrl.href}|ru=${rejectUnauthorized}|pru=${proxyRejectUnauthorized}`;
}

export function getOutboundHttpsAgent({ proxyUrl = null, tlsOptions = {} } = {}) {
  if (!proxyUrl) {
    if (!directHttpsAgent) {
      directHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
    }
    return directHttpsAgent;
  }
  const key = buildProxyAgentKey(proxyUrl, tlsOptions);
  const existing = proxyHttpsAgents.get(key);
  if (
    existing &&
    existing.ca === tlsOptions.ca &&
    existing.proxyCa === tlsOptions.proxyCa
  ) {
    return existing.agent;
  }
  const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
  // Pool TLS sockets established over HTTP CONNECT tunnels so consecutive
  // requests to the same target host:port reuse the tunneled connection.
  agent.createConnection = (options) => {
    const targetHost = stripBrackets(options.host || options.hostname || '');
    const targetPort = Number(options.port) || 443;
    const tunnel = createConnectTunnel(proxyUrl, targetHost, targetPort, {
      rejectUnauthorized: tlsOptions.proxyRejectUnauthorized ?? true,
      ...(tlsOptions.proxyCa ? { ca: tlsOptions.proxyCa } : {}),
    });
    const socket = tls.connect({
      socket: tunnel,
      servername: net.isIP(targetHost) ? undefined : targetHost,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: tlsOptions.rejectUnauthorized ?? true,
      ...(tlsOptions.ca ? { ca: tlsOptions.ca } : {}),
    });
    socket.once('close', () => {
      if (!tunnel.destroyed) tunnel.destroy();
    });
    return socket;
  };
  if (!tlsOptions.ca && !tlsOptions.proxyCa) {
    proxyHttpsAgents.set(key, { agent, ca: undefined, proxyCa: undefined });
  }
  return agent;
}

export function destroyOutboundProxyAgents() {
  if (directHttpsAgent) {
    directHttpsAgent.destroy();
    directHttpsAgent = null;
  }
  for (const { agent } of proxyHttpsAgents.values()) {
    agent.destroy();
  }
  proxyHttpsAgents.clear();
}

export async function fetchWithProxy(url, init = {}, { env = process.env, fetchImpl = fetch, tlsOptions = {} } = {}) {
  const proxyUrl = fetchImpl === fetch ? resolveOutboundProxy(url, env) : null;
  if (!proxyUrl) return fetchImpl(url, init);
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== 'https:') return fetchImpl(url, init);
  const targetHost = stripBrackets(target.hostname);
  const targetPort = Number(target.port) || 443;
  const body = normalizeRequestBody(init.body);
  const headers = normalizeHeaders(init.headers);
  if (body && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(body.length);
  }
  if (init.signal?.aborted) throw init.signal.reason || new DOMException('Aborted', 'AbortError');
  const agent = getOutboundHttpsAgent({ proxyUrl, tlsOptions });
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const req = https.request({
      host: targetHost,
      port: targetPort,
      path: target.pathname + target.search,
      method: init.method || 'GET',
      headers,
      agent,
    }, (res) => {
      const status = res.statusCode || 502;
      if (init.redirect === 'error' && status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        done(new TypeError('Unexpected redirect'));
        return;
      }
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item);
        else responseHeaders.set(k, String(v));
      }
      const webBody = status === 204 || status === 304 || init.method === 'HEAD' ? null : Readable.toWeb(res);
      done(null, new Response(webBody, { status, headers: responseHeaders }));
    });
    const onAbort = () => {
      req.destroy();
      done(init.signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      done(err);
    });
    if (body) req.write(body);
    req.end();
  });
}
