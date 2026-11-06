// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { main } from "../src/cli.js";
import { which } from "../src/util.js";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DIST_CLI = join(ROOT, "dist", "cli.js");

export function tmp(prefix = "orch-t-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Snapshot and restore the given env vars around each test. */
export function keepEnv(keys: string[]): void {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** The TmpHome base of the v1.1 suite: a fresh ORCH_HOME per test. */
export function useTmpHome(): { home: string } {
  const ctx = { home: "" };
  keepEnv(["ORCH_HOME", "ORCH_AGENT", "ORCH_SESSION_ID"]);
  beforeEach(() => {
    ctx.home = tmp();
    process.env.ORCH_HOME = ctx.home;
    delete process.env.ORCH_AGENT;
    delete process.env.ORCH_SESSION_ID;
  });
  afterEach(() => {
    rmSync(ctx.home, { recursive: true, force: true });
  });
  return ctx;
}

/** Run the CLI in-process. Returns [exit code, stdout, stderr]. */
export async function run(...argv: string[]): Promise<[number, string, string]> {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s), stdin: () => "" });
  return [code, out, err];
}

/** Like run, with a fixed stdin. */
export async function runStdin(stdin: string, ...argv: string[]): Promise<[number, string, string]> {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s), stdin: () => stdin });
  return [code, out, err];
}

export const WINDOWS = process.platform === "win32";
/** PATH as it was when this file loaded, before any test narrows it. */
const ORIGINAL_PATH = process.env.PATH ?? "";

/** Windows only: Git for Windows' sh.exe, which runs the shell bodies of the fake programs. */
function windowsSh(): string {
  const git = which("git", ORIGINAL_PATH);
  const near = git ? [join(dirname(git), "sh.exe"), join(dirname(dirname(git)), "bin", "sh.exe"), join(dirname(dirname(git)), "usr", "bin", "sh.exe")] : [];
  const sh = which("sh", ORIGINAL_PATH) ?? near.find((p) => existsSync(p));
  if (!sh) throw new Error("the tests need sh.exe from Git for Windows on PATH");
  return sh;
}

/**
 * A PATH for tests: the given directories, then the system ones. On Windows the system ones are
 * the folder git is in and System32 (PATH is `;`-separated there and has no /usr/bin).
 */
export function testPath(...dirs: string[]): string {
  if (!WINDOWS) return [...dirs, "/usr/bin", "/bin"].join(":");
  const git = which("git", ORIGINAL_PATH);
  return [...dirs, ...(git ? [dirname(git)] : []), join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(";");
}

/**
 * A fake program whose behaviour is the shell `body`. On Windows it is a .cmd file (what an
 * npm-installed CLI is there) that hands the same body to Git for Windows' sh.
 */
export function fakeBin(dir: string, name: string, body = 'cat > "$ORCH_TEST_OUT"'): string {
  if (WINDOWS) {
    writeFileSync(join(dir, `${name}.sh`), `#!/bin/sh\nPATH="/usr/bin:$PATH"\n${body}\n`);
    const p = join(dir, `${name}.cmd`);
    writeFileSync(p, `@echo off\r\n"${windowsSh()}" "%~dp0${name}.sh" %*\r\n`);
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A fake program written as an ES module: a `#!node` script, or on Windows a .cmd file that starts node on it. */
export function fakeNodeBin(dir: string, name: string, source: string): string {
  if (WINDOWS) {
    writeFileSync(join(dir, `${name}.mjs`), source);
    const p = join(dir, `${name}.cmd`);
    writeFileSync(p, `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  return p;
}

export async function waitFor(pred: () => boolean, tries = 50, ms = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return pred();
}
