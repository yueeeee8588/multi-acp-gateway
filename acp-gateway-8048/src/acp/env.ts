import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGY_BRIDGE_AGENT_NAME, ensureMinimalAgentDefinition } from "./minimal-agent";

export const HOST_HOME = process.env.HOME;
export const HOST_XDG_DATA_HOME = process.env.XDG_DATA_HOME;
export const HOST_PATH = process.env.PATH ?? "";

export interface BuildIsolatedAgyEnvOptions {
  homeDir: string;
  proxyUrl?: string;
  agyPath?: string;
  dataRoot?: string;
}

export interface BuildAgyWorkerArgsOptions {
  homeDir: string;
  workspaceDir: string;
  logFile?: string;
}

const SENSITIVE_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_CONFIG_REL_DIR",
] as const;

const LOOPBACK_NO_PROXY_ENTRIES = ["127.0.0.1", "localhost", "::1"] as const;

export function getDataRoot(customRoot?: string): string {
  const root =
    customRoot ||
    process.env.AGY_8048_DATA_DIR ||
    process.env.AGY_ACP_DATA_DIR ||
    (HOST_XDG_DATA_HOME
      ? path.join(HOST_XDG_DATA_HOME, "agy-gemini-8048")
      : path.join(HOST_HOME || os.homedir(), ".local", "share", "agy-gemini-8048"));

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
  } catch {}
  return root;
}

export function getBrowserShimDir(dataRoot?: string): string {
  const shimDir = path.join(getDataRoot(dataRoot), "bin-shims");
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o755 });

  if (process.platform === "win32") {
    const openCmd = path.join(shimDir, "open.cmd");
    if (!fs.existsSync(openCmd)) {
      fs.writeFileSync(openCmd, "@exit /b 1\r\n", { mode: 0o755 });
    }
  } else {
    for (const name of ["open", "xdg-open"]) {
      const filePath = path.join(shimDir, name);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      } else {
        try {
          fs.chmodSync(filePath, 0o755);
        } catch {}
      }
    }
  }
  return shimDir;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function collectAntigravityProgramDirs(baseProgramsDir: string): string[] {
  const dirs: string[] = [];
  try {
    if (!fs.existsSync(baseProgramsDir)) {
      return dirs;
    }
    const entries = fs.readdirSync(baseProgramsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^antigravity/i.test(entry.name)) {
        const fullDir = path.join(baseProgramsDir, entry.name);
        dirs.push(path.join(fullDir, "bin"), fullDir);
      }
    }
  } catch {
    // Ignore unreadable program directories during auto-detection.
  }
  return dirs;
}

export function resolveOfficialAgyBinary(agyPath?: string): string {
  const envAgyPath = process.env.AGY_PATH?.trim();
  if (envAgyPath) {
    if (isExistingFile(envAgyPath)) {
      return envAgyPath;
    }
    console.warn(
      `[acp-8048] AGY_PATH is set to '${envAgyPath}', but file does not exist; falling back to config/auto-detection.`,
    );
  }

  const configAgyPath = agyPath?.trim();
  if (configAgyPath) {
    if (isExistingFile(configAgyPath)) {
      return configAgyPath;
    }
    console.warn(
      `[acp-8048] Configured agyPath '${configAgyPath}' does not exist; falling back to auto-detection.`,
    );
  }

  const windows = process.platform === "win32";
  const names = windows ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
  const pathsToSearch: string[] = [];

  const pathEnv = process.env.PATH || HOST_PATH;
  if (pathEnv) {
    pathsToSearch.push(...pathEnv.split(path.delimiter).filter(Boolean));
  }

  const home = process.env.HOME || process.env.USERPROFILE || HOST_HOME || os.homedir();
  if (windows) {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programData = process.env.ProgramData || "C:\\ProgramData";
    pathsToSearch.push(
      ...collectAntigravityProgramDirs(path.join(localAppData, "Programs")),
      path.join(localAppData, "Programs", "agy", "bin"),
      path.join(localAppData, "Programs", "agy"),
      path.join(localAppData, "agy", "bin"),
      path.join(localAppData, "agy"),
      path.join(home, ".local", "bin"),
      path.join(home, ".gemini", "bin"),
    );
    if (process.env.ProgramFiles) {
      pathsToSearch.push(
        ...collectAntigravityProgramDirs(process.env.ProgramFiles),
      );
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      pathsToSearch.push(
        ...collectAntigravityProgramDirs(programFilesX86),
      );
    }
    pathsToSearch.push(
      ...collectAntigravityProgramDirs(home),
      path.join(home, "agy", "bin"),
      path.join(home, "agy"),
      path.join(home, "Desktop", "agy", "bin"),
      path.join(home, "Desktop", "agy"),
      path.join(home, "Downloads", "agy", "bin"),
      path.join(home, "Downloads", "agy"),
      path.join(home, "scoop", "shims"),
      path.join(home, "scoop", "apps", "agy", "current", "bin"),
      path.join(home, "scoop", "apps", "agy", "current"),
      path.join(programData, "chocolatey", "bin"),
      path.join(process.cwd(), "agy", "bin"),
      path.join(process.cwd(), "agy"),
      path.join(process.cwd(), "bin"),
      "C:\\agy\\bin",
      "C:\\agy",
    );
  } else {
    pathsToSearch.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".gemini", "bin"),
    );
  }

  const seenDirs = new Set<string>();

  for (const dir of pathsToSearch) {
    const normalizedDir = windows ? path.resolve(dir).toLowerCase() : path.resolve(dir);
    if (seenDirs.has(normalizedDir)) continue;
    seenDirs.add(normalizedDir);

    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Antigravity CLI (agy.exe / agy) binary not found. Checked AGY_PATH, config.agyPath, PATH, and standard install directories. Please install agy.exe or specify its path in config.agyPath or AGY_PATH.",
  );
}

export function resolveAgyBinary(agyPath?: string): string {
  return resolveOfficialAgyBinary(agyPath);
}

function mergeNoProxy(existing?: string): string {
  const items = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(items.map((s) => s.toLowerCase()));
  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!seen.has(entry.toLowerCase())) {
      items.push(entry);
      seen.add(entry.toLowerCase());
    }
  }
  return items.join(",");
}

export function ensureIsolatedHomeStructure(homeDir: string): void {
  const geminiDir = path.join(homeDir, ".gemini");
  const agyCliDir = path.join(geminiDir, "antigravity-cli");
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agyCliDir, { recursive: true, mode: 0o700 });
}

export function buildIsolatedAgyEnv(opts: BuildIsolatedAgyEnvOptions): Record<string, string> {
  const homeDir = path.resolve(opts.homeDir);
  ensureIsolatedHomeStructure(homeDir);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

  for (const key of SENSITIVE_ENV_KEYS) {
    delete env[key];
  }

  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  env.XDG_STATE_HOME = path.join(homeDir, ".local", "state");
  env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
  env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 22";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  env.BROWSER = "/usr/bin/false";

  if (opts.agyPath) {
    env.AGY_PATH = opts.agyPath;
  }

  const shimDir = getBrowserShimDir(opts.dataRoot);
  const currentPath = env.PATH ?? env.Path ?? HOST_PATH;
  env.PATH = currentPath ? `${shimDir}${path.delimiter}${currentPath}` : shimDir;
  if (process.platform === "win32" && "Path" in env) {
    env.Path = env.PATH;
  }

  const normalizedProxy = opts.proxyUrl?.trim();
  if (normalizedProxy) {
    env.HTTP_PROXY = normalizedProxy;
    env.HTTPS_PROXY = normalizedProxy;
    env.ALL_PROXY = normalizedProxy;
    env.http_proxy = normalizedProxy;
    env.https_proxy = normalizedProxy;
    env.all_proxy = normalizedProxy;

    const loopbackNoProxy = LOOPBACK_NO_PROXY_ENTRIES.join(",");
    env.NO_PROXY = loopbackNoProxy;
    env.no_proxy = loopbackNoProxy;
  }

  return env;
}

export function buildAgyWorkerArgs(opts: BuildAgyWorkerArgsOptions): string[] {
  const homeDir = path.resolve(opts.homeDir);
  ensureMinimalAgentDefinition(opts.workspaceDir);
  const args = [
    "acp",
    "--gemini-dir",
    path.join(homeDir, ".gemini"),
    "--app-data-dir",
    "antigravity-cli",
    "--agent",
    AGY_BRIDGE_AGENT_NAME,
    "--stdio",
    "--worker",
    "--disable-telemetry",
  ];
  if (opts.logFile) {
    args.push("--log-file", opts.logFile);
  }
  return args;
}
