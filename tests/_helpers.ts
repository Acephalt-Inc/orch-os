// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { main } from "../src/cli.js";

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

export function fakeBin(dir: string, name: string, body = 'cat > "$ORCH_TEST_OUT"'): string {
  if (process.platform === "win32") {
    const script = join(dir, `${name}.js`);
    const p = join(dir, `${name}.cmd`);
    writeFileSync(script, "process.stdin.resume();\n");
    writeFileSync(p, `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

export async function waitFor(pred: () => boolean, tries = 50, ms = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return pred();
}
