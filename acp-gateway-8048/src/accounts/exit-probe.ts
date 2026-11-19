import type { AccountRecord, ExitGroup } from "../types";

export interface ExitProbeResult {
  exitIp: string;
  exitCountry: string;
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
      if (!res.ok) continue;

      const data = (await res.json()) as Record<string, unknown>;
      const parsed = source.parse(data);
      if (parsed && parsed.exitIp) {
        return parsed;
      }
    } catch {
      // 安全降级，尝试下一个探测源
    }
  }

  return { exitIp: "", exitCountry: "" };
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
