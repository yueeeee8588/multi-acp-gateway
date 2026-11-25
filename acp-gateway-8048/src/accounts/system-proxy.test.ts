import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getConfig, updateConfig } from "../config/settings";
import {
  __resetSystemProxyCacheForTest,
  parseWindowsInternetSettingsOutput,
  parseWindowsProxyEnable,
  parseWindowsProxyServer,
  readWindowsSystemProxy,
  resolveEffectiveProxy,
} from "./system-proxy";

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

let savedDefaultProxy = "";
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetSystemProxyCacheForTest();
  savedDefaultProxy = getConfig().defaultProxy;
  for (const k of PROXY_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  updateConfig({ defaultProxy: "" });
});

afterEach(() => {
  __resetSystemProxyCacheForTest();
  updateConfig({ defaultProxy: savedDefaultProxy });
  for (const k of PROXY_ENV_KEYS) {
    const val = savedEnv[k];
    if (val === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = val;
    }
  }
});

describe("parseWindowsProxyEnable", () => {
  test("parses hex and decimal DWORD values", () => {
    expect(parseWindowsProxyEnable("    ProxyEnable    REG_DWORD    0x1\r\n")).toBe(true);
    expect(parseWindowsProxyEnable("    ProxyEnable    REG_DWORD    1\r\n")).toBe(true);
    expect(parseWindowsProxyEnable("    ProxyEnable    REG_DWORD    0x0\r\n")).toBe(false);
    expect(parseWindowsProxyEnable("    ProxyEnable    REG_DWORD    0\r\n")).toBe(false);
    expect(parseWindowsProxyEnable("")).toBe(false);
  });
});

describe("parseWindowsProxyServer", () => {
  test("normalizes bare host:port to http:// URL", () => {
    expect(parseWindowsProxyServer("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(parseWindowsProxyServer("  http://127.0.0.1:7890/  ")).toBe("http://127.0.0.1:7890");
  });

  test("parses semicolon-separated protocol mappings", () => {
    expect(
      parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7891")
    ).toBe("http://127.0.0.1:7891");
    expect(
      parseWindowsProxyServer("http=127.0.0.1:7890;ftp=127.0.0.1:7890")
    ).toBe("http://127.0.0.1:7890");
    expect(parseWindowsProxyServer("socks=127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
  });

  test("returns undefined on empty or invalid inputs", () => {
    expect(parseWindowsProxyServer("")).toBeUndefined();
    expect(parseWindowsProxyServer("   ")).toBeUndefined();
    expect(parseWindowsProxyServer("http=;https=")).toBeUndefined();
  });
});

describe("parseWindowsInternetSettingsOutput", () => {
  test("extracts ProxyServer only when ProxyEnable is non-zero", () => {
    const enabledOutput = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890",
    ].join("\r\n");
    expect(parseWindowsInternetSettingsOutput(enabledOutput)).toBe("http://127.0.0.1:7890");

    const disabledOutput = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "    ProxyEnable    REG_DWORD    0x0",
      "    ProxyServer    REG_SZ    127.0.0.1:7890",
    ].join("\r\n");
    expect(parseWindowsInternetSettingsOutput(disabledOutput)).toBeUndefined();
  });
});

describe("readWindowsSystemProxy", () => {
  test("caches result for 15s and handles errors safely", () => {
    let calls = 0;
    let fakeNow = 1000;
    const regOutput = [
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    127.0.0.1:7897",
    ].join("\r\n");

    const first = readWindowsSystemProxy({
      platform: "win32",
      now: () => fakeNow,
      exec: () => {
        calls++;
        return regOutput;
      },
    });
    expect(first).toBe("http://127.0.0.1:7897");
    expect(calls).toBe(1);

    fakeNow += 5000;
    const cached = readWindowsSystemProxy({
      platform: "win32",
      now: () => fakeNow,
      exec: () => {
        calls++;
        return regOutput;
      },
    });
    expect(cached).toBe("http://127.0.0.1:7897");
    expect(calls).toBe(1);

    fakeNow += 11_000;
    const expired = readWindowsSystemProxy({
      platform: "win32",
      now: () => fakeNow,
      exec: () => {
        calls++;
        throw new Error("reg.exe failed");
      },
    });
    expect(expired).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("returns undefined on non-win32 platforms", () => {
    expect(
      readWindowsSystemProxy({
        platform: "linux",
        exec: () => {
          throw new Error("should not execute");
        },
      })
    ).toBeUndefined();
  });
});

describe("resolveEffectiveProxy", () => {
  test("follows priority: explicit -> defaultProxy -> env -> system proxy", () => {
    updateConfig({ defaultProxy: "http://127.0.0.1:8888" });
    const env: NodeJS.ProcessEnv = {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:1080",
    };

    expect(resolveEffectiveProxy("  http://127.0.0.1:9999 ", env)).toBe(
      "http://127.0.0.1:9999"
    );
    expect(resolveEffectiveProxy("", env)).toBe("http://127.0.0.1:8888");

    updateConfig({ defaultProxy: "" });
    expect(resolveEffectiveProxy("", env)).toBe("http://127.0.0.1:7890");
    expect(resolveEffectiveProxy("", { all_proxy: "socks5://127.0.0.1:1081" })).toBe(
      "socks5://127.0.0.1:1081"
    );
  });
});
