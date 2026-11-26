import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/settings";
import { buildAgyLoginArgs, buildIsolatedAgyEnv, getBrowserShimDir, resolveOfficialAgyBinary } from "./env";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function touchBinary(dir: string, name = process.platform === "win32" ? "agy.exe" : "agy"): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "stub");
  return filePath;
}

const originalEnv = {
  AGY_PATH: process.env.AGY_PATH,
  PATH: process.env.PATH,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  ProgramFiles: process.env.ProgramFiles,
  "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
  SSH_CONNECTION: process.env.SSH_CONNECTION,
  BROWSER: process.env.BROWSER,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DEFAULT_CONFIG.agyPath", () => {
  test("defaults to empty string for auto-detection", () => {
    expect(DEFAULT_CONFIG.agyPath).toBe("");
  });
});

describe("resolveOfficialAgyBinary", () => {
  test("prefers AGY_PATH over config.agyPath when both exist", () => {
    const root = makeTempDir("agy-env-prio-");
    const envBin = touchBinary(path.join(root, "env"));
    const cfgBin = touchBinary(path.join(root, "cfg"));

    process.env.AGY_PATH = envBin;
    expect(resolveOfficialAgyBinary(cfgBin)).toBe(envBin);
  });

  test("uses config.agyPath when AGY_PATH is unset", () => {
    const root = makeTempDir("agy-cfg-");
    const cfgBin = touchBinary(path.join(root, "cfg"));

    delete process.env.AGY_PATH;
    expect(resolveOfficialAgyBinary(cfgBin)).toBe(cfgBin);
  });

  test("warns and falls back to PATH / standard dirs when configured agyPath does not exist", () => {
    const root = makeTempDir("agy-fallback-");
    const pathBinDir = path.join(root, "path-bin");
    const pathBin = touchBinary(pathBinDir);

    delete process.env.AGY_PATH;
    process.env.PATH = pathBinDir;

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const resolved = resolveOfficialAgyBinary(path.join(root, "missing", "agy.exe"));
      expect(resolved).toBe(pathBin);
      expect(warnings.some((w) => w.includes("does not exist"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("discovers binary in standard Antigravity* install dir when PATH is empty", () => {
    const root = makeTempDir("agy-std-");
    const localAppData = path.join(root, "LocalAppData");
    const stdBin = touchBinary(path.join(localAppData, "Programs", "Antigravity-CLI", "bin"));

    delete process.env.AGY_PATH;
    process.env.PATH = "";
    process.env.LOCALAPPDATA = localAppData;
    process.env.USERPROFILE = path.join(root, "UserProfile");
    process.env.HOME = path.join(root, "Home");
    process.env.ProgramFiles = path.join(root, "ProgramFiles");

    if (process.platform === "win32") {
      expect(resolveOfficialAgyBinary("")).toBe(stdBin);
    }
  });

  test("throws clear diagnostic error when no binary is found", () => {
    const root = makeTempDir("agy-missing-");
    delete process.env.AGY_PATH;
    process.env.PATH = "";
    process.env.LOCALAPPDATA = path.join(root, "LocalAppData");
    process.env.USERPROFILE = path.join(root, "UserProfile");
    process.env.HOME = path.join(root, "Home");
    process.env.ProgramFiles = path.join(root, "ProgramFiles");
    process.env["ProgramFiles(x86)"] = path.join(root, "ProgramFilesX86");

    expect(() => resolveOfficialAgyBinary("")).toThrow(/AGY_PATH/);
  });

  test("discovers binary in ProgramFiles(x86) antigravity* and portable Desktop paths on Windows", () => {
    if (process.platform !== "win32") return;

    const root = makeTempDir("agy-x86-portable-");
    const pfX86 = path.join(root, "ProgramFilesX86");
    const x86Bin = touchBinary(path.join(pfX86, "AntigravityCLI", "bin"));

    delete process.env.AGY_PATH;
    process.env.PATH = "";
    process.env.LOCALAPPDATA = path.join(root, "LocalAppData");
    process.env.USERPROFILE = path.join(root, "UserProfile");
    process.env.HOME = path.join(root, "Home");
    process.env.ProgramFiles = path.join(root, "ProgramFiles");
    process.env["ProgramFiles(x86)"] = pfX86;

    expect(resolveOfficialAgyBinary("")).toBe(x86Bin);

    fs.rmSync(pfX86, { recursive: true, force: true });
    const portableBin = touchBinary(path.join(process.env.HOME, "Desktop", "agy", "bin"));
    expect(resolveOfficialAgyBinary("")).toBe(portableBin);
  });
});

describe("buildIsolatedAgyEnv", () => {
  test("blocks browser by default and when allowBrowser is false", () => {
    const root = makeTempDir("agy-env-default-");
    const homeDir = path.join(root, "home");
    const dataRoot = path.join(root, "data");
    const expectedShimDir = getBrowserShimDir(dataRoot);

    for (const allowBrowser of [undefined, false] as const) {
      const env = buildIsolatedAgyEnv({ homeDir, dataRoot, allowBrowser });
      expect(env.BROWSER).toBe("/usr/bin/false");
      expect(env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 22");
      expect(env.PATH.startsWith(`${expectedShimDir}${path.delimiter}`)).toBe(true);
      if (process.platform === "win32" && "Path" in env) {
        expect(env.Path).toBe(env.PATH);
      }
    }
  });

  test("allows browser and skips SSH_CONNECTION / bin-shims when allowBrowser is true", () => {
    const root = makeTempDir("agy-env-browser-");
    const homeDir = path.join(root, "home");
    const dataRoot = path.join(root, "data");
    const expectedShimDir = path.join(dataRoot, "bin-shims");

    delete process.env.SSH_CONNECTION;
    delete process.env.BROWSER;

    const env = buildIsolatedAgyEnv({ homeDir, dataRoot, allowBrowser: true });
    expect(env.BROWSER).toBeUndefined();
    expect(env.SSH_CONNECTION).toBeUndefined();
    expect(env.PATH.startsWith(`${expectedShimDir}${path.delimiter}`)).toBe(false);
    if (process.platform === "win32" && "Path" in env) {
      expect(env.Path.startsWith(`${expectedShimDir}${path.delimiter}`)).toBe(false);
    }
  });
});

describe("buildAgyLoginArgs", () => {
  test("returns acp --login with isolated gemini-dir and app-data-dir", () => {
    const root = makeTempDir("agy-login-args-");
    const homeDir = path.join(root, "acc-home");
    expect(buildAgyLoginArgs(homeDir)).toEqual([
      "acp",
      "--login",
      "--gemini-dir",
      path.join(path.resolve(homeDir), ".gemini"),
      "--app-data-dir",
      "antigravity-cli",
    ]);
  });
});
