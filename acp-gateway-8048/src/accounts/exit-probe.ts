import net from "node:net";
import type { AccountRecord, ExitGroup } from "../types";

export interface ExitProbeResult {
  exitIp: string;
  exitCountry: string;
  probeOk?: boolean;
  error?: string;
}

export interface ProxyReachabilityResult {
  ok: boolean;
  error?: string;
}

export interface ExitIpDriftResult {
  drifted: boolean;
  previousExitIp: string;
  previousExitCountry: string;
  currentExitIp: string;
  currentExitCountry: string;
  reason?: string;
}

export type TcpConnectProbeFn = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<ProxyReachabilityResult>;

const DEFAULT_PROXY_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "socks:": 1080,
  "socks4:": 1080,
  "socks4a:": 1080,
  "socks5:": 1080,
  "socks5h:": 1080,
};

export function parseProxyHostPort(
  proxyUrl: string,
): { host: string; port: number } | { error: string } {
  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    return { error: "Empty proxy URL" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    return { error: `Invalid proxy URL: ${trimmed}` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").trim();
  if (!host) {
    return { error: `Missing host in proxy URL: ${trimmed}` };
  }

  let port = parsed.port ? Number(parsed.port) : DEFAULT_PROXY_PORTS[parsed.protocol];
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `Invalid or missing port in proxy URL: ${trimmed}` };
  }

  return { host, port };
}

function defaultTcpConnectProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ProxyReachabilityResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (result: ProxyReachabilityResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `TCP connect timeout after ${timeoutMs}ms (${host}:${port})` });
    }, timeoutMs);

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () =>
      finish({ ok: false, error: `TCP connect timeout after ${timeoutMs}ms (${host}:${port})` }),
    );
    socket.once("error", (err) => {
      finish({ ok: false, error: err?.message || `TCP connect failed (${host}:${port})` });
    });
  });
}

let tcpConnectProbe: TcpConnectProbeFn = defaultTcpConnectProbe;

export function __setTcpConnectProbeForTest(fn: TcpConnectProbeFn | null): void {
  tcpConnectProbe = fn ?? defaultTcpConnectProbe;
}

export async function checkProxyReachable(
  proxyUrl: string,
  timeoutMs = 2000,
): Promise<ProxyReachabilityResult> {
  const parsed = parseProxyHostPort(proxyUrl);
  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 2000;
  try {
    return await tcpConnectProbe(parsed.host, parsed.port, effectiveTimeout);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function detectExitIpDrift(
  previous: { exitIp?: string; exitCountry?: string },
  current: { exitIp?: string; exitCountry?: string },
): ExitIpDriftResult {
  const previousExitIp = previous.exitIp?.trim() ?? "";
  const previousExitCountry = previous.exitCountry?.trim() ?? "";
  const currentExitIp = current.exitIp?.trim() ?? "";
  const currentExitCountry = current.exitCountry?.trim() ?? "";

  if (!previousExitIp || !currentExitIp) {
    return {
      drifted: false,
      previousExitIp,
      previousExitCountry,
      currentExitIp,
      currentExitCountry,
    };
  }

  const ipChanged = currentExitIp !== previousExitIp;
  const countryChanged =
    Boolean(previousExitCountry) &&
    Boolean(currentExitCountry) &&
    currentExitCountry !== previousExitCountry;

  if (!ipChanged && !countryChanged) {
    return {
      drifted: false,
      previousExitIp,
      previousExitCountry,
      currentExitIp,
      currentExitCountry,
    };
  }

  const prevLabel = previousExitCountry
    ? `${previousExitIp} (${previousExitCountry})`
    : previousExitIp;
  const currLabel = currentExitCountry
    ? `${currentExitIp} (${currentExitCountry})`
    : currentExitIp;

  return {
    drifted: true,
    previousExitIp,
    previousExitCountry,
    currentExitIp,
    currentExitCountry,
    reason: `Exit IP drift detected: ${prevLabel} -> ${currLabel}`,
  };
}

interface ProbeSource {
  url: string;
  parse: (data: Record<string, unknown>) => ExitProbeResult | null;
}

const PROBE_SOURCES: ProbeSource[] = [
  {
    url: "https://ipinfo.io/json",
    parse: (d) =>
      typeof d.ip === "string"
        ? { exitIp: d.ip, exitCountry: typeof d.country === "string" ? d.country : "" }
        : null,
  },
  {
    url: "https://api.ip.sb/geoip",
    parse: (d) =>
      typeof d.ip === "string"
        ? {
            exitIp: d.ip,
            exitCountry: typeof d.country_code === "string" ? d.country_code : "",
          }
        : null,
  },
  {
    url: "https://ipapi.co/json/",
    parse: (d) =>
      typeof d.ip === "string"
        ? {
            exitIp: d.ip,
            exitCountry: typeof d.country_code === "string" ? d.country_code : "",
          }
        : null,
  },
];

export async function probeAccountExit(
  proxyUrl?: string,
  timeoutMs = 4000,
): Promise<ExitProbeResult> {
  let lastError = "";
  for (const source of PROBE_SOURCES) {
    try {
      const fetchOpts: RequestInit & { proxy?: string } = {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "agy-gemini-8048/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (proxyUrl && proxyUrl.trim()) {
        fetchOpts.proxy = proxyUrl.trim();
      }

      const res = await fetch(source.url, fetchOpts);
      if (!res.ok) {
        lastError = `${source.url} returned HTTP ${res.status}`;
        continue;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const parsed = source.parse(data);
      if (parsed && parsed.exitIp) {
        return { ...parsed, probeOk: true };
      }
      lastError = `${source.url} returned empty exit IP`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // 安全降级，尝试下一个探测源
    }
  }

  return {
    exitIp: "",
    exitCountry: "",
    probeOk: false,
    error: lastError || "All exit probe sources failed",
  };
}

export function aggregateExits(accounts: AccountRecord[]): ExitGroup[] {
  const groups = new Map<string, { country: string; accountIds: string[] }>();

  for (const acc of accounts) {
    const ip = acc.exitIp?.trim() || "unknown";
    const existing = groups.get(ip);
    if (existing) {
      existing.accountIds.push(acc.id);
      if (!existing.country && acc.exitCountry) {
        existing.country = acc.exitCountry;
      }
    } else {
      groups.set(ip, {
        country: acc.exitCountry || "",
        accountIds: [acc.id],
      });
    }
  }

  const result: ExitGroup[] = [];
  for (const [ip, g] of groups.entries()) {
    result.push({
      ip,
      country: g.country,
      accountIds: g.accountIds,
      count: g.accountIds.length,
      sharedWarning: ip !== "unknown" && g.accountIds.length > 1,
    });
  }
  return result;
}
