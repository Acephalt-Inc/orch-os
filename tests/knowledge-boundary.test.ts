// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The deadline of the knowledge demo, and what the built module touches while it runs: child
// processes are started under fixtures/knowledge/probe.mjs, which reports every file, network
// and process call on a separate channel.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoTransport } from "../src/knowledge/demo.js";
import { Transport } from "../src/knowledge/schema.js";
import {
  AUDITED, BINDING, canary, CONTROL, DIST, ENTRY, errorLine, FIXED_TIME, HOSTILE, INVOICE_REQUEST, node, okLine,
  QUERY, ROOT, run, sandbox, SCENARIO, sha256, sleep, unexpected,
} from "./fixtures/knowledge/harness.js";

const DEADLINE_MS = 5000;
/** How long after the deadline a result may arrive in these tests: timer and scheduling slack. */
const TOLERANCE_MS = 2000;
/** When the late replies below arrive, counted from the start of the query. */
const LATE_MS = DEADLINE_MS + 300;
const TIMEOUT_LINE = errorLine("TIMEOUT");

function late<T>(value: () => Promise<T>): Promise<T> {
  return sleep(LATE_MS).then(value);
}

describe.concurrent("knowledge deadline", () => {
  it("knowledge timeout exits without late output", async () => {
    let aborted = false;
    const transport: Transport = {
      lookup: (_request, signal) => new Promise(() => {
        signal.addEventListener("abort", () => (aborted = true));
      }),
      revalidate: createDemoTransport().revalidate,
    };
    const started = performance.now();
    const r = await run(QUERY, transport);
    const elapsed = performance.now() - started;
    expect(r.code).toBe(1);
    expect(r.err).toBe(TIMEOUT_LINE);
    expect(r.out).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 10);
    expect(elapsed).toBeLessThan(DEADLINE_MS + TOLERANCE_MS);
    expect(aborted).toBe(true);
    await sleep(300);
    expect(r.outWrites).toEqual([]);
    expect(r.errWrites).toEqual([TIMEOUT_LINE]);
    expect(r.calls).toHaveLength(1);
  }, 15_000);

  it("knowledge timeout: a lookup that resolves after the deadline starts no recheck", async () => {
    // This transport ignores cancellation and answers correctly, only too late.
    const base = createDemoTransport();
    let resolved = false;
    const transport: Transport = {
      lookup: (request, signal) => late(() => base.lookup(request, signal)).finally(() => (resolved = true)),
      revalidate: base.revalidate,
    };
    const r = await run(QUERY, transport);
    expect(r.code).toBe(1);
    expect(r.err).toBe(TIMEOUT_LINE);
    expect(r.out).toBe("");
    // The result was reported while the lookup was still pending.
    expect(resolved).toBe(false);
    await sleep(LATE_MS - DEADLINE_MS + 300);
    expect(resolved).toBe(true);
    expect(r.calls.map((c) => c.name)).toEqual(["lookup"]);
    expect(r.outWrites).toEqual([]);
    expect(r.errWrites).toEqual([TIMEOUT_LINE]);
  }, 15_000);

  it("knowledge timeout: a recheck that resolves after the deadline emits nothing", async () => {
    const base = createDemoTransport();
    let resolved = false;
    const transport: Transport = {
      lookup: base.lookup,
      revalidate: (binding, ref, signal) => {
        return late(() => base.revalidate(binding, ref, signal)).finally(() => (resolved = true));
      },
    };
    const started = performance.now();
    const r = await run(QUERY, transport);
    const elapsed = performance.now() - started;
    expect(r.code).toBe(1);
    expect(r.err).toBe(TIMEOUT_LINE);
    expect(r.out).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 10);
    expect(resolved).toBe(false);
    await sleep(LATE_MS - DEADLINE_MS + 300);
    expect(resolved).toBe(true);
    expect(r.calls.map((c) => c.name)).toEqual(["lookup", "revalidate"]);
    expect(r.outWrites).toEqual([]);
    expect(r.errWrites).toEqual([TIMEOUT_LINE]);
  }, 15_000);
});

describe("knowledge built module", () => {
  it("knowledge shared result is independent of personal state: the module source names no personal lookup", () => {
    // A static supplement to the probe runs below: no environment, directory, home, file,
    // network or process access is written anywhere in the module.
    const modules = "fs|os|net|tls|dns|dgram|http|http2|https|child_process|worker_threads|cluster";
    const personal = new RegExp(`process\\.(env|cwd|chdir)|homedir|userInfo|node:(${modules})\\b`);
    for (const name of ["command.ts", "demo.ts", "entry.ts", "query.ts", "schema.ts"]) {
      const source = readFileSync(join(ROOT, "src", "knowledge", name), "utf8");
      expect(source.split("\n").filter((line) => personal.test(line)), name).toEqual([]);
    }
  });

  it("knowledge timeout: the built entry answers the demo query and exits within the deadline", async () => {
    // No tolerance is added: start-up, the query and exit together stay under the 5-second bound.
    // A timer left running would hold the process until that bound.
    const child = await node([ENTRY, ...QUERY]);
    expect([child.code, child.signal]).toEqual([0, null]);
    expect(JSON.parse(child.stdout).status).toBe("OK");
    expect(child.ms).toBeLessThan(DEADLINE_MS);
  });

  it("knowledge shared result is independent of personal state: built entry under the probe", async () => {
    const base = sandbox();
    try {
      const a = canary(base, "A");
      const b = canary(base, "B");
      const first = await node([ENTRY, ...QUERY], { cwd: a.cwd, env: a.env, probe: true });
      const second = await node([ENTRY, ...QUERY], { cwd: b.cwd, env: b.env, probe: true });
      // Byte-identical results under two different homes, stores, host files and directories.
      expect(first.stdout).toBe(okLine("invoice-terms"));
      expect(second.stdout).toBe(first.stdout);
      expect([first.stderr, second.stderr]).toEqual(["", ""]);
      expect([first.code, first.signal, second.code, second.signal]).toEqual([0, null, 0, null]);
      // The probe was live in both runs: it saw Node load the entry file.
      expect(first.calls).toContainEqual({ kind: "file", name: "fs.realpathSync", target: ENTRY, detail: null });
      // Nothing but Node reading the audited files: no personal open, write, network or process.
      expect(unexpected(first.calls, AUDITED)).toEqual([]);
      expect(unexpected(second.calls, AUDITED)).toEqual([]);
      expect(second.calls).toEqual(first.calls);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("knowledge probe records a file, a network and a process call when one is made", async () => {
    const base = sandbox();
    try {
      const readPath = join(base, "read.txt");
      const writePath = join(base, "written.txt");
      // A local socket nobody listens on; on Windows that is a pipe name, not a file path.
      const pipeName = `\\\\.\\pipe\\${base.replace(/[\\/:]/g, "-")}`;
      const socketPath = process.platform === "win32" ? pipeName : join(base, "absent.sock");
      writeFileSync(readPath, "PRIVATE-NOTE-CANARY\n");
      const child = await node([CONTROL, readPath, writePath, socketPath], { cwd: base, probe: true });
      expect([child.code, child.signal, child.stderr]).toEqual([0, null, ""]);
      expect(existsSync(writePath)).toBe(true);
      // The same filter the other tests rely on, here with something to find.
      const found = unexpected(child.calls, [CONTROL]);
      expect(found).toContainEqual({ kind: "file", name: "fs.readFileSync", target: readPath, detail: null });
      expect(found).toContainEqual({ kind: "file", name: "fs.writeFileSync", target: writePath, detail: null });
      expect(found).toContainEqual({ kind: "network", name: "net.connect", target: socketPath, detail: null });
      expect(found).toContainEqual({
        kind: "process", name: "child_process.spawnSync", target: process.execPath, detail: null,
      });
      // Node loading the control file itself is not among them.
      expect(found.filter((c) => c.target === CONTROL)).toEqual([]);
      expect(child.calls.filter((c) => c.target === CONTROL)).not.toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("knowledge source instructions stay quoted data: no file, network or process call", async () => {
    const base = sandbox();
    try {
      const c = canary(base, "A");
      const child = await node([SCENARIO, DIST, "hostile"], { cwd: c.cwd, env: c.env, probe: true });
      expect([child.code, child.signal, child.stderr]).toEqual([0, null, ""]);
      const ref = { document_id: "invoice-policy", revision: 3, fragment: "terms", sha256: sha256(HOSTILE) };
      expect(JSON.parse(child.stdout)).toEqual({
        code: 0,
        out: JSON.stringify({
          status: "OK",
          mode: "synthetic",
          question_id: "invoice-terms",
          answer: HOSTILE,
          citation: { ...ref, retrieved_at: FIXED_TIME, checked_at: FIXED_TIME },
        }) + "\n",
        err: "",
        calls: [
          { name: "lookup", request: INVOICE_REQUEST },
          { name: "revalidate", binding: BINDING, ref },
        ],
      });
      expect(child.calls).toContainEqual({ kind: "file", name: "fs.realpathSync", target: SCENARIO, detail: null });
      expect(unexpected(child.calls, [...AUDITED, SCENARIO])).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("knowledge import and help have no operational side effects: built module under the probe", async () => {
    const base = sandbox();
    try {
      const c = canary(base, "A");
      // Loading the module files other than the entry runs no query and prints nothing.
      const loaded = await node([SCENARIO, DIST, "import"], { cwd: c.cwd, env: c.env, probe: true });
      expect([loaded.code, loaded.signal, loaded.stdout, loaded.stderr]).toEqual([0, null, "", ""]);
      expect(loaded.calls).toContainEqual({ kind: "file", name: "fs.realpathSync", target: SCENARIO, detail: null });
      expect(unexpected(loaded.calls, [...AUDITED, SCENARIO])).toEqual([]);

      const help = await node([ENTRY, "--help"], { cwd: c.cwd, env: c.env, probe: true });
      expect([help.code, help.signal, help.stderr]).toEqual([0, null, ""]);
      expect(help.stdout).toContain("Synthetic demo; no service connected.");
      expect(help.calls).toContainEqual({ kind: "file", name: "fs.realpathSync", target: ENTRY, detail: null });
      expect(unexpected(help.calls, AUDITED)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
