import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  detectChromePath,
  getChromeLocalStatePath,
  parseChromeLocalState,
  parseWindowsAppPathRegistryOutput,
} from "./chrome-scan";

describe("parseChromeLocalState", () => {
  test("extracts signed-in profiles, filters empty emails, and deduplicates against existingEmails", () => {
    const sampleLocalState = JSON.stringify({
      profile: {
        info_cache: {
          Default: {
            name: "Personal",
            user_name: "Alice@Example.com",
            gaia_name: "Alice Smith",
          },
          "Profile 1": {
            name: "Work",
            user_name: "bob@example.com",
            gaia_name: "Bob",
          },
          "Profile 2": {
            name: "Guest-like",
            user_name: "   ",
            gaia_name: "No Email",
          },
          "Profile 3": {
            name: "Unsigned",
            gaia_name: "Unsigned User",
          },
        },
      },
    });

    const profiles = parseChromeLocalState(sampleLocalState, [
      "alice@example.com",
      "other@example.com",
    ]);

    expect(profiles).toEqual([
      {
        profileDir: "Default",
        name: "Personal",
        email: "Alice@Example.com",
        gaiaName: "Alice Smith",
        alreadyAdded: true,
      },
      {
        profileDir: "Profile 1",
        name: "Work",
        email: "bob@example.com",
        gaiaName: "Bob",
        alreadyAdded: false,
      },
    ]);
  });

  test("returns empty array on malformed JSON or missing info_cache", () => {
    expect(parseChromeLocalState("{bad-json", [])).toEqual([]);
    expect(parseChromeLocalState("{}", [])).toEqual([]);
    expect(parseChromeLocalState(JSON.stringify({ profile: {} }), [])).toEqual([]);
  });
});

describe("detectChromePath", () => {
  test("probes ProgramFiles, ProgramFiles(x86), and LOCALAPPDATA in order", () => {
    const env: NodeJS.ProcessEnv = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    };

    const expectedLocal = path.join(
      "C:\\Users\\test\\AppData\\Local",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    );

    const found = detectChromePath(env, (p) => p === expectedLocal);
    expect(found).toBe(expectedLocal);

    const notFound = detectChromePath(env, () => false, {
      platform: "win32",
      readAppPath: () => null,
    });
    expect(notFound).toBeNull();
  });

  test("prefers CHROME_PATH env var when readable", () => {
    const customChrome = "X:\\Portable\\Chrome\\chrome.exe";
    const stdChrome = path.join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
    const env: NodeJS.ProcessEnv = {
      CHROME_PATH: `  "${customChrome}"  `,
      ProgramFiles: "C:\\Program Files",
    };

    const found = detectChromePath(env, (p) => p === customChrome || p === stdChrome, {
      platform: "win32",
      readAppPath: () => null,
    });
    expect(found).toBe(customChrome);
  });

  test("falls back to Windows App Paths registry for chrome.exe before Edge", () => {
    const regChrome = "X:\\Apps\\Chrome\\chrome.exe";
    const edgeStd = path.join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
    const env: NodeJS.ProcessEnv = {
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    };

    const found = detectChromePath(env, (p) => p === regChrome || p === edgeStd, {
      platform: "win32",
      readAppPath: (exe) => (exe === "chrome.exe" ? regChrome : null),
    });
    expect(found).toBe(regChrome);
  });

  test("falls back to Edge standard paths and App Paths msedge.exe when Chrome is absent", () => {
    const edgeStd = path.join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
    const env: NodeJS.ProcessEnv = {
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramFiles: "C:\\Program Files",
    };

    expect(
      detectChromePath(env, (p) => p === edgeStd, {
        platform: "win32",
        readAppPath: () => null,
      })
    ).toBe(edgeStd);

    const regEdge = "X:\\CustomEdge\\msedge.exe";
    expect(
      detectChromePath(env, (p) => p === regEdge, {
        platform: "win32",
        readAppPath: (exe) => (exe === "msedge.exe" ? regEdge : null),
      })
    ).toBe(regEdge);
  });
});

describe("parseWindowsAppPathRegistryOutput", () => {
  test("parses quoted REG_SZ and expands environment variables", () => {
    const out = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
      '    (Default)    REG_EXPAND_SZ    "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    ].join("\r\n");

    expect(parseWindowsAppPathRegistryOutput(out, { ProgramFiles: "C:\\Program Files" })).toBe(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    );
  });
});

describe("getChromeLocalStatePath", () => {
  test("selects Edge Local State when browserPath ends with msedge.exe or Chrome Local State is missing", () => {
    const env: NodeJS.ProcessEnv = {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    };
    const chromeState = path.join(env.LOCALAPPDATA!, "Google", "Chrome", "User Data", "Local State");
    const edgeState = path.join(env.LOCALAPPDATA!, "Microsoft", "Edge", "User Data", "Local State");

    expect(
      getChromeLocalStatePath(env, {
        browserPath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        existsSync: () => true,
      })
    ).toBe(edgeState);

    expect(
      getChromeLocalStatePath(env, {
        browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        existsSync: (p) => p === edgeState,
      })
    ).toBe(edgeState);

    expect(
      getChromeLocalStatePath(env, {
        browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        existsSync: (p) => p === chromeState || p === edgeState,
      })
    ).toBe(chromeState);
  });
});
