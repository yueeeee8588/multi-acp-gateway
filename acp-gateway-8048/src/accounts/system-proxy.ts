import { execFileSync } from "node:child_process";
import path from "node:path";
import { getConfig } from "../config/settings";

const SYSTEM_PROXY_CACHE_TTL_MS = 15_000;
const INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

interface SystemProxyCache {
  expiresAt: number;
  value: string | undefined;
}

let systemProxyCache: SystemProxyCache | null = null;

export function __resetSystemProxyCacheForTest(): void {
  systemProxyCache = null;
}

function getRegExePath(systemRoot?: string): string {
  const root = (systemRoot ?? process.env.SystemRoot ?? "C:\\Windows").trim() || "C:\\Windows";
  return path.join(root, "System32", "reg.exe");
}

function normalizeProxyEntry(rawValue: string, defaultScheme: "http" | "socks5" = "http"): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${defaultScheme}://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return undefined;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function parseWindowsProxyEnable(regOutput: string): boolean {
  const match = regOutput.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i);
  if (!match?.[1]) return false;
  const raw = match[1].trim();
  const value = raw.toLowerCase().startsWith("0x")
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value !== 0;
}

export function parseWindowsProxyServer(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (!trimmed.includes("=")) {
    return normalizeProxyEntry(trimmed, "http");
  }

  const entries = new Map<string, string>();
  for (const part of trimmed.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const proto = part.slice(0, eqIndex).trim().toLowerCase();
    const addr = part.slice(eqIndex + 1).trim();
    if (proto && addr) {
      entries.set(proto, addr);
    }
  }

  for (const proto of ["https", "http"] as const) {
    const addr = entries.get(proto);
    if (addr) {
      const normalized = normalizeProxyEntry(addr, "http");
      if (normalized) return normalized;
    }
  }

  const socksAddr = entries.get("socks") ?? entries.get("socks5") ?? entries.get("socks4");
  if (socksAddr) {
    const normalized = normalizeProxyEntry(socksAddr, "socks5");
    if (normalized) return normalized;
  }

  return undefined;
}

export function parseWindowsInternetSettingsOutput(regOutput: string): string | undefined {
  if (!parseWindowsProxyEnable(regOutput)) {
    return undefined;
  }
  const serverMatch = regOutput.match(/ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+([^\r\n]+)/i);
  if (!serverMatch?.[1]) {
    return undefined;
  }
  return parseWindowsProxyServer(serverMatch[1]);
}

function defaultExecRegQuery(regExePath: string, args: string[]): string {
  return execFileSync(regExePath, args, {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });
}

export function readWindowsSystemProxy(opts?: {
  forceRefresh?: boolean;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  exec?: (regExePath: string, args: string[]) => string;
  now?: () => number;
}): string | undefined {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "win32") {
    return undefined;
  }

  const now = (opts?.now ?? Date.now)();
  if (!opts?.forceRefresh && systemProxyCache && now < systemProxyCache.expiresAt) {
    return systemProxyCache.value;
  }

  let resolved: string | undefined;
  try {
    const regExe = getRegExePath(opts?.systemRoot);
    const exec = opts?.exec ?? defaultExecRegQuery;
    const output = exec(regExe, ["query", INTERNET_SETTINGS_KEY]);
    resolved = parseWindowsInternetSettingsOutput(output);
  } catch {
    resolved = undefined;
  }

  systemProxyCache = {
    expiresAt: now + SYSTEM_PROXY_CACHE_TTL_MS,
    value: resolved,
  };
  return resolved;
}

export function resolveEffectiveProxy(
  explicitProxy?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = typeof explicitProxy === "string" ? explicitProxy.trim() : "";
  if (explicit) {
    return explicit;
  }

  const configProxy = getConfig().defaultProxy?.trim();
  if (configProxy) {
    return configProxy;
  }

  const envProxy =
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim() ||
    env.ALL_PROXY?.trim() ||
    env.all_proxy?.trim();
  if (envProxy) {
    return envProxy;
  }

  return readWindowsSystemProxy();
}
