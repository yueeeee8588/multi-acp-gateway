import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/settings";
import { resolveOfficialAgyBinary } from "./env";

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

    expect(() => resolveOfficialAgyBinary("")).toThrow(/AGY_PATH/);
  });
});
