import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ContextError,
  type ContextStatus,
  contextStatus,
  disableContext,
  unlockContext,
} from "./context-unlock";

const USAGE = `Usage:
  context-unlock-cli unlock            Copy official agy, patch only the copy (1M context)
  context-unlock-cli status            Show current context unlock status
  context-unlock-cli disable [--purge] Disable context unlock (optionally purge managed files)
  context-unlock-cli --help            Show this help message`;

function printStatus(status: ContextStatus, out: (line: string) => void): void {
  out(`context unlock: ${status.state}${status.active ? " (active)" : ""}`);
  out(`active: ${status.active}`);
  out(`state: ${status.state}`);
  out(`reason: ${status.reason}`);
  out(`dir: ${status.dir}`);
  if (status.path) out(`path: ${status.path}`);
  if (status.agyVersion) out(`agy version: ${status.agyVersion}`);
  if (status.source) out(`source: ${status.source}  sha256 ${status.sourceSha256 ?? ""}`);
  if (status.patchedSha256) out(`patched sha256: ${status.patchedSha256}`);
}

export function main(
  argv: string[],
  opts: {
    out?: (line: string) => void;
    err?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): number {
  const out = opts.out ?? console.log;
  const err = opts.err ?? console.error;
  const env = opts.env ?? process.env;
  const [action, ...rest] = argv;

  try {
    if (action === "status" && rest.length === 0) {
      printStatus(contextStatus({ env, full: true }), out);
      return 0;
    }
    if (action === "unlock" && rest.length === 0) {
      printStatus(unlockContext({ env }), out);
      return 0;
    }
    if (action === "disable" && rest.every((arg) => arg === "--purge")) {
      printStatus(disableContext({ env, purge: rest.includes("--purge") }), out);
      return 0;
    }
    out(USAGE);
    return action === "--help" || action === "-h" || action === "help" ? 0 : 2;
  } catch (error) {
    if (error instanceof ContextError) {
      err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const isMain = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
