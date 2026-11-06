// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Small shared helpers: names, PATH lookup, synchronous sleep, atomic writes, process checks. */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import {
  accessSync, closeSync, constants, fsyncSync, openSync, renameSync, statSync, writeSync, chmodSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

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

/** The file types `which` accepts on Windows. PATHEXT only orders them: its default also lists script types. */
export const WINDOWS_PROGRAM_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

/** A Windows path with a drive and a root (`C:\x`), or a UNC path. `\x` and `C:x` depend on the current drive or folder. */
export function isFullyQualifiedWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(p);
}

/**
 * May Windows lookup take programs from this directory? Only from a fully qualified one: a
 * relative entry would make the current folder a place programs are taken from. (When the
 * Windows rules are selected on another host, as tests do, that host's absolute paths count.)
 */
export function isWindowsSearchDir(dir: string): boolean {
  return process.platform === "win32" ? isFullyQualifiedWindowsPath(dir) : isAbsolute(dir);
}

/**
 * Like Python's shutil.which. On Windows: PATHEXT resolution limited to program files
 * (.com .exe .bat .cmd), and PATH entries that are not fully qualified are skipped. The current
 * directory is never searched. On other systems the lookup is the one it always was.
 */
export function which(cmd: string | undefined | null, envPath?: string, platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"): string | null {
  if (!cmd) return null;
  const win = platform === "win32";
  let extensions = [""];
  if (win && !WINDOWS_PROGRAM_EXTENSIONS.includes(extname(cmd).toLowerCase())) {
    const listed = pathExt.split(";").map((x) => x.toLowerCase()).filter((x) => WINDOWS_PROGRAM_EXTENSIONS.includes(x));
    extensions = listed.length ? listed : WINDOWS_PROGRAM_EXTENSIONS;
  }
  const candidates = (base: string) => extensions.map((x) => base + x);
  if (cmd.includes("/") || (win && cmd.includes("\\"))) {
    if (win && !isFullyQualifiedWindowsPath(cmd)) return null;
    return candidates(cmd).find((p) => isCommandFile(p, platform)) ?? null;
  }
  const path = envPath ?? process.env.PATH ?? "";
  const sep = win ? ";" : delimiter;
  for (let d of path.split(sep)) {
    if (win) d = d.replace(/^"(.*)"$/, "$1");
    if (!d || (win && !isWindowsSearchDir(d))) continue;
    const p = candidates(join(d, cmd)).find((candidate) => isCommandFile(candidate, platform));
    if (p) return p;
  }
  return null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote one argument for a .bat or .cmd file started through cmd.exe. First the quoting the
 * final program's argument parser expects; then a caret before every cmd.exe metacharacter, the
 * quotes included, so cmd.exe never sees a quoted region and expands nothing. `parses` is how
 * many times cmd.exe reads the text: 2 for a batch file that forwards its arguments with %*
 * (once on the command line, once inside the file).
 */
export function quoteCmdArg(arg: string, parses = 2): string {
  let s = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  for (let i = 0; i < parses; i++) s = s.replace(CMD_META, "^$1");
  return s;
}

/** cmd.exe by full path: %ComSpec% when it is fully qualified, else the one in the Windows folder. Never a bare name. */
export function cmdExe(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = env.ComSpec ?? env.COMSPEC ?? "";
  return isFullyQualifiedWindowsPath(comspec) ? comspec : `${env.SystemRoot || env.windir || "C:\\Windows"}\\System32\\cmd.exe`;
}

/**
 * The fixed cmd.exe invocation for an already-resolved .cmd or .bat file. The command line is
 * built only here, from quoted arguments; start it with windowsVerbatimArguments (runResolved does).
 * cmd.exe ends a command at a line break, so an argument that contains one is refused.
 */
export function cmdInvocation(command: string, args: string[]): [string, string[]] {
  if ([command, ...args].some((a) => /[\r\n\0]/.test(a))) {
    throw new Error(`${command} is a .cmd or .bat file, and cmd.exe cannot pass it an argument that contains a line break`);
  }
  const line = [command.replace(CMD_META, "^$1"), ...args.map((a) => quoteCmdArg(a))].join(" ");
  return [cmdExe(), ["/d", "/v:off", "/s", "/c", `"${line}"`]];
}

/**
 * Start an already-resolved program (a `which` result) and wait for it. A .bat or .cmd file
 * goes through cmdInvocation; nothing else reaches a shell, and no shell string is built from
 * the caller's input anywhere else.
 */
export function runResolved(file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding,
  platform: NodeJS.Platform = process.platform): SpawnSyncReturns<string> {
  if (platform === "win32" && /\.(bat|cmd)$/i.test(file)) {
    const [exe, cmdArgs] = cmdInvocation(file, args);
    return spawnSync(exe, cmdArgs, { ...options, argv0: "cmd.exe", windowsVerbatimArguments: true });
  }
  return spawnSync(file, args, options);
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Block the thread for `ms` milliseconds (used only while waiting for a file lock). */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * renameSync. Windows refuses a rename while another process has the file, or a file inside the
 * directory, open (a reader of the same state, a virus scanner). There the refusal is retried
 * for up to about two seconds; other systems rename once, as before.
 */
export function renameRetry(from: string, to: string, opts: {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
} = {}): void {
  const {
    platform = process.platform,
    rename = renameSync,
    sleep = sleepSync,
  } = opts;
  for (let i = 0; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (e: any) {
      const busy = e?.code === "EPERM" || e?.code === "EACCES" || e?.code === "EBUSY";
      if (platform !== "win32" || !busy || i >= 60) throw e;
      sleep(Math.min(2 + i * 2, 40));
    }
  }
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
  renameRetry(tmp, path);
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
  if (!checkZombie || process.platform === "win32") return true; // Windows has no zombies and no ps
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
