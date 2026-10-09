// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Small shared helpers: names, PATH lookup, synchronous sleep, atomic writes, process checks. */
import { spawnSync } from "node:child_process";
import {
  accessSync, closeSync, constants, fsyncSync, openSync, renameSync, statSync, writeSync, chmodSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";

/** Names (authors, workers, readers, task ids, note names): letters, digits, `_ . @ -`. */
export const NAME_RE = /^[\p{L}\p{N}_.@-]+$/u;

export function validName(name: string | undefined | null): name is string {
  return typeof name === "string" && NAME_RE.test(name) && !name.startsWith(".");
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isCommandFile(p: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return isExecutableFile(p);
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Like Python's shutil.which, including PATHEXT resolution on Windows. */
export function which(cmd: string | undefined | null, envPath?: string, platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"): string | null {
  if (!cmd) return null;
  const extensions = platform === "win32"
    ? (extname(cmd) ? [""] : pathExt.split(";").filter(Boolean)).map((x) => x.toLowerCase())
    : [""];
  const candidates = (base: string) => extensions.map((x) => base + x);
  if (cmd.includes("/") || cmd.includes("\\")) {
    return candidates(cmd).find((p) => isCommandFile(p, platform)) ?? null;
  }
  const path = envPath ?? process.env.PATH ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  for (const d of path.split(sep)) {
    if (!d) continue;
    const p = candidates(join(d, cmd)).find((candidate) => isCommandFile(candidate, platform));
    if (p) return p;
  }
  return null;
}

/** Quote one argument for cmd.exe without allowing metacharacters or percent expansion. */
export function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/%/g, "%%").replace(/([&|<>^])/g, "^$1").replace(/"/g, '""')}"`;
}

/** A fixed cmd.exe invocation for an already-resolved .cmd or .bat command. */
export function cmdInvocation(command: string, args: string[]): [string, string[]] {
  return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")]];
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Block the thread for `ms` milliseconds (used only while waiting for a file lock). */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write `data` to a temp file beside `path`, optionally fsync it, then rename it into place. */
export function atomicWrite(path: string, data: string, opts: { fsync?: boolean; mode?: number; tmpSuffix?: string } = {}): void {
  const tmp = path + (opts.tmpSuffix ?? `.tmp${process.pid}`);
  const fd = openSync(tmp, "w", opts.mode ?? 0o644);
  try {
    writeSync(fd, data);
    if (opts.fsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (opts.mode !== undefined) chmodSync(path, opts.mode);
}

/** kill(pid, 0) semantics: gone => false, exists (even if not ours) => true. Zombies count as gone. */
export function pidAlive(pid: number, checkZombie = true): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e && e.code === "EPERM") return true;
    return false;
  }
  if (!checkZombie) return true;
  // A zombie still answers kill(0); ask ps for its state.
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  if (r.status === 0 && r.stdout.trim().startsWith("Z")) return false;
  return true;
}

export function defaultSession(): string {
  let user = "user";
  try {
    user = userInfo().username;
  } catch { /* keep default */ }
  return `${user}@${hostname()}`;
}

/** os.path.expandvars + expanduser: $VAR / ${VAR} when defined, leading ~. */
export function expandPath(p: string): string {
  let s = p.replace(/\$(\w+)|\$\{([^}]+)\}/g, (m, a, b) => {
    const v = process.env[a ?? b];
    return v === undefined ? m : v;
  });
  if (s === "~" || s.startsWith("~/")) {
    const home = process.env.HOME || userInfo().homedir;
    s = home + s.slice(1);
  }
  return s;
}

export function absPath(p: string): string {
  return resolve(p);
}

/** Python-style fixed-width left pad (`f"{s:<n}"`). */
export function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
