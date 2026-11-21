import { describe, expect, it } from "bun:test";
import {
  openUrlInAccountChrome,
  type ChromeScanResult,
} from "../src/accounts/chrome-scan";

function makeScanResult(overrides?: Partial<ChromeScanResult>): ChromeScanResult {
  return {
    chromeAvailable: true,
    chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    profiles: [
      {
        profileDir: "Profile 2",
        name: "Work Account",
        email: "Alice.Smith@Example.COM",
        gaiaName: "Alice Smith",
        alreadyAdded: true,
      },
      {
        profileDir: "Default",
        name: "",
        email: "bob@example.com",
        gaiaName: "Bob Gaia",
        alreadyAdded: false,
      },
    ],
    ...overrides,
  };
}

describe("openUrlInAccountChrome", () => {
  it("matches account email case-insensitively and spawns Chrome with matching profileDir and trimmed URL", () => {
    const spawnCalls: Array<{
      cmd: string[];
      options: { stdout: "ignore"; stderr: "ignore"; stdin: "ignore" };
    }> = [];

    const result = openUrlInAccountChrome(
      "  alice.smith@example.com  ",
      "  https://accounts.google.com/v3/signin/challenge?foo=bar  ",
      {
        scan: () => makeScanResult(),
        spawn: (cmd, options) => {
          spawnCalls.push({ cmd, options });
          return { pid: 12345 };
        },
      }
    );

    expect(result).toEqual({
      ok: true,
      launched: true,
      profileDir: "Profile 2",
      profileName: "Work Account",
      email: "Alice.Smith@Example.COM",
      url: "https://accounts.google.com/v3/signin/challenge?foo=bar",
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      cmd: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "--profile-directory=Profile 2",
        "https://accounts.google.com/v3/signin/challenge?foo=bar",
      ],
      options: {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      },
    });
  });

  it("falls back profileName to gaiaName when profile name is empty", () => {
    let spawned = false;
    const result = openUrlInAccountChrome("bob@example.com", "http://127.0.0.1:8080/verify", {
      scan: () => makeScanResult(),
      spawn: () => {
        spawned = true;
      },
    });

    expect(spawned).toBe(true);
    expect(result).toEqual({
      ok: true,
      launched: true,
      profileDir: "Default",
      profileName: "Bob Gaia",
      email: "bob@example.com",
      url: "http://127.0.0.1:8080/verify",
    });
  });

  it("returns profile_not_found when no Chrome profile matches the email or email is empty", () => {
    let spawnCalled = false;

    const missingRes = openUrlInAccountChrome(
      "not-found@example.com",
      "https://support.google.com/accounts",
      {
        scan: () => makeScanResult(),
        spawn: () => {
          spawnCalled = true;
        },
      }
    );

    expect(missingRes).toEqual({
      ok: true,
      launched: false,
      reason: "profile_not_found",
      email: "not-found@example.com",
    });

    const emptyEmailRes = openUrlInAccountChrome("", "https://support.google.com/accounts", {
      scan: () => makeScanResult(),
      spawn: () => {
        spawnCalled = true;
      },
    });

    expect(emptyEmailRes).toEqual({
      ok: true,
      launched: false,
      reason: "profile_not_found",
      email: "",
    });
    expect(spawnCalled).toBe(false);
  });

  it("returns chrome_not_found when Chrome is unavailable", () => {
    let spawnCalled = false;

    const result = openUrlInAccountChrome("alice.smith@example.com", "https://accounts.google.com", {
      scan: () =>
        makeScanResult({
          chromeAvailable: false,
          chromePath: null,
          profiles: [],
        }),
      spawn: () => {
        spawnCalled = true;
      },
    });

    expect(result).toEqual({
      ok: true,
      launched: false,
      reason: "chrome_not_found",
    });
    expect(spawnCalled).toBe(false);
  });

  it("rejects non-http(s) protocols, empty URLs, and control characters", () => {
    let scanCalled = false;
    let spawnCalled = false;
    const deps = {
      scan: () => {
        scanCalled = true;
        return makeScanResult();
      },
      spawn: () => {
        spawnCalled = true;
      },
    };

    const invalidUrls = [
      "",
      "   ",
      "javascript:alert(1)",
      "file:///C:/Windows/System32/calc.exe",
      "data:text/html,<script>alert(1)</script>",
      "https://accounts.google.com/path\r\n--headless",
      "https://accounts.google.com/path\0",
    ];

    for (const badUrl of invalidUrls) {
      expect(() => openUrlInAccountChrome("alice.smith@example.com", badUrl, deps)).toThrow();
    }

    expect(scanCalled).toBe(false);
    expect(spawnCalled).toBe(false);
  });
});
