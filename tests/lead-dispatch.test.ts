import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Lease } from "../src/lease.js";
import { LeadLoop } from "../src/lead/runtime.js";
import { Messages } from "../src/messages.js";
import { Workers } from "../src/workers.js";
import { Tasks } from "../src/tasks.js";
import { DIST_CLI, ROOT, WINDOWS, useTmpHome } from "./_helpers.js";

describe("approved lead dispatch", () => {
  const ctx = useTmpHome();
  const env = () => ({ ...process.env, ORCH_HOME: ctx.home });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...args], { env: env(), encoding: "utf8", timeout: 15000 });
    return { code: r.status, value: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  };
  const task = (timeout_seconds = 2) => {
    const p = join(ctx.home, "task.json");
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e", "process.exit(0)"], workdir: ctx.home, timeout_seconds }));
    return p;
  };
  const approved = (epoch: number, p: string) => ["dispatch", "--session", "session-a", "--expected-epoch", String(epoch), "--task-file", p, "--approved"];
  const waitExit = async () => {
    const exit = join(ctx.home, "lease.json.lead-task.json.exit");
    for (let i = 0; i < 100 && !existsSync(exit); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(exit)).toBe(true);
    const pid = JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json.gate"), "utf8")).pid;
    let gone = false;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") { gone = true; break; } }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(gone, `supervisor ${pid} was not observed to exit`).toBe(true);
    return exit;
  };
  // These launch/evidence scenarios need POSIX process control. Windows must explicitly
  // prove refusal and zero launch state instead of expecting a task that cannot run.
  const dispatchIt = (name: string, body: () => unknown, timeout?: number) => it(
    WINDOWS ? `${name} (UNAVAILABLE: Windows has no process-control adapter)` : name, async () => {
      if (!WINDOWS) { await body(); return; }
      const b = cli("boot", "--session", "session-a").value, p = task();
      const result = cli(...approved(b.epoch, p));
      expect(result.code).toBe(2);
      expect(result.value).toMatchObject({ status: "UNAVAILABLE", reason: expect.stringContaining("Windows") });
      for (const path of ["lease.json.lead-task.json", "lease.json.lead-task.json.gate", "tasks/task-a.json", "workers"])
        expect(existsSync(join(ctx.home, path))).toBe(false);
      console.info(`[unavailable] ${name}: ${result.value.reason}`);
    }, timeout);
  it.each(["darwin", "linux"] as const)("accepts compatible uutils timeout on %s", (platform) => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const probe = vi.fn((_command: string, args: string[]) => ({ status: 137,
      stdout: args[0] === "--version" ? "timeout (uutils coreutils) 0.10.0" : "" }));
    const start = vi.spyOn(Workers.prototype, "start").mockImplementation(() => { throw new Error("worker preflight reached"); });
    try {
      const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")),
        new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")), {},
        { platform, find: () => process.execPath, probe });
      expect(loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, approved: true, taskFile: p }))
        .toEqual([2, { status: "BLOCKED", reason: "worker preflight reached" }]);
      expect(start).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledWith(process.execPath, ["--foreground", "--kill-after=1s", "1s", process.execPath, "-e", expect.stringContaining("SIGTERM")]);
    } finally { start.mockRestore(); }
  });
  it.each([0, 42, 124])("refuses a timeout probe without kill-after evidence (exit %i)", (status) => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")),
      new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")), {},
      { platform: "linux", find: () => process.execPath, probe: () => ({ status, stdout: "GNU coreutils" }) });
    const [code, value] = loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, approved: true, taskFile: p });
    expect([code, value.status]).toEqual([2, "UNAVAILABLE"]);
    expect(existsSync(loop.taskPath)).toBe(false);
  });
  it("ignores a probe killed by its outer deadline and tries gtimeout", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const start = vi.spyOn(Workers.prototype, "start").mockImplementation(() => { throw new Error("worker preflight reached"); });
    const probe = vi.fn((command: string) => command === "timeout"
      ? { status: null, signal: "SIGKILL", error: new Error("outer deadline") } : { status: 137 });
    try {
      const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")),
        new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")), {},
        { platform: "darwin", find: (name) => name, probe });
      expect(loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, approved: true, taskFile: p }))
        .toEqual([2, { status: "BLOCKED", reason: "worker preflight reached" }]);
      expect(JSON.parse(readFileSync(loop.taskPath, "utf8")).timeout_bin).toBe("gtimeout");
      expect(probe).toHaveBeenCalledTimes(2);
    } finally { start.mockRestore(); }
  });
  it("leaves no reservation if the lease expires during timeout probing", () => {
    const b = cli("boot", "--session", "session-a", "--seconds", "60").value, p = task();
    const now = Date.now(), clock = vi.spyOn(Date, "now");
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")),
      new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")), {},
      { platform: "linux", find: () => process.execPath, probe: () => {
        clock.mockReturnValue(now + 61_000); return { status: 137 };
      } });
    try {
      expect(loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, approved: true, taskFile: p }))
        .toEqual([4, { status: "STALE_LEASE" }]);
      expect(existsSync(loop.taskPath)).toBe(false);
      expect(existsSync(join(ctx.home, "tasks", "task-a.json"))).toBe(false);
    } finally { clock.mockRestore(); }
  });
  it("reports Windows process control unavailable before probing or claiming", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const find = vi.fn(), probe = vi.fn();
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")),
      new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")), {}, { platform: "win32", find, probe });
    const [code, value] = loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, approved: true, taskFile: p });
    expect(code).toBe(2);
    expect(value).toMatchObject({ status: "UNAVAILABLE", reason: expect.stringContaining("Windows") });
    expect(find).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    expect(existsSync(loop.taskPath)).toBe(false);
    expect(existsSync(join(ctx.home, "tasks", "task-a.json"))).toBe(false);
  });
  it("rejects missing approval and invalid timeout before reserving or claiming", () => {
    const b = cli("boot", "--session", "session-a").value;
    const p = task(0);
    expect(cli("dispatch", "--session", "session-a", "--expected-epoch", String(b.epoch), "--task-file", p, "--approved").code).toBe(2);
    task();
    expect(cli("dispatch", "--session", "session-a", "--expected-epoch", String(b.epoch), "--task-file", p).code).toBe(2);
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json"))).toBe(false);
    expect(existsSync(join(ctx.home, "tasks", "task-a.json"))).toBe(false);
  });
  dispatchIt("reserves one task, publishes verified exit on tick, and blocks a second dispatch", async () => {
    const b = cli("boot", "--session", "session-a").value;
    const p = task();
    const first = cli("dispatch", "--session", "session-a", "--expected-epoch", String(b.epoch), "--task-file", p, "--approved");
    expect(first.code, first.err).toBe(0);
    expect(first.value.status).toBe("DISPATCHED");
    const second = cli("dispatch", "--session", "session-a", "--expected-epoch", String(b.epoch), "--task-file", p, "--approved");
    expect(second.value.status).toBe("BLOCKED");
    await waitExit();
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.code, tick.err).toBe(0);
    expect(tick.value.completion).toMatchObject({ task: "task-a", status: "EXITED", exit_code: 0 });
    expect(tick.value.events).toHaveLength(1);
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value.events).toHaveLength(0);
    expect(readFileSync(join(ctx.home, "messages.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
  dispatchIt("lead_completion_release_allows_next_approved_task", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const first = cli(...approved(b.epoch, p));
    expect(first.code, first.err).toBe(0);
    await waitExit();
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.value.completion?.task).toBe("task-a");
    expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8")).phase, "[completion-release]").toBe("RELEASED");
    const input = JSON.parse(readFileSync(p, "utf8"));
    input.id = "task-b";
    writeFileSync(p, JSON.stringify(input));
    const second = cli(...approved(b.epoch, p));
    expect(second.code, `[completion-release] ${second.err}`).toBe(0);
    expect(second.value.task).toBe("task-b");
    await waitExit();
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "2", "--approved").value.completion?.task).toBe("task-b");
    expect(new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")).all().map((m) => m.id)).toEqual([
      expect.stringContaining("lead-completion-"), expect.stringContaining("lead-completion-")]);
  });
  dispatchIt("recovers a committed cursor before its release tombstone", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").code).toBe(0);
    const reservationPath = join(ctx.home, "lease.json.lead-task.json");
    const reservation = JSON.parse(readFileSync(reservationPath, "utf8"));
    delete reservation.proof;
    reservation.phase = "CLAIMED";
    writeFileSync(reservationPath, JSON.stringify(reservation));
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value.status).toBe("DUPLICATE");
    expect(JSON.parse(readFileSync(reservationPath, "utf8")).phase, "[cursor-boundary]").toBe("RELEASED");
    expect(new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")).all()).toHaveLength(1);
  });
  dispatchIt("recovers a released tombstone after one old sidecar was removed", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").code).toBe(0);
    unlinkSync(join(ctx.home, "lease.json.lead-task.json.gate"));
    const input = JSON.parse(readFileSync(p, "utf8")); input.id = "task-b"; writeFileSync(p, JSON.stringify(input));
    const result = cli(...approved(b.epoch, p));
    expect(result.code, `[partial-cleanup] ${result.err}`).toBe(0);
    await waitExit();
    expect(result.value.task).toBe("task-b");
  });
  dispatchIt("allows another holder to claim the completed task before the next dispatch", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").code).toBe(0);
    expect(new Tasks(join(ctx.home, "tasks")).claim("task-a", "other-holder")[0]).toBe(0);
    const input = JSON.parse(readFileSync(p, "utf8")); input.id = "task-b"; writeFileSync(p, JSON.stringify(input));
    const result = cli(...approved(b.epoch, p));
    expect(result.code, `[reclaimed-task] ${result.err}`).toBe(0);
    await waitExit();
  });
  dispatchIt("keeps a live process group from releasing a consumed completion", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")),
      new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")), {},
      { platform: "linux", find: () => null, probe: () => ({ status: null }) }, () => true);
    const tick = loop.run("tick", { session: "session-a", expectedEpoch: b.epoch, tick: 1, approved: true });
    expect(tick[0]).toBe(0);
    expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8")).phase, "[active-group]").toBe("CLAIMED");
    expect(loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, taskFile: p, approved: true })[1].status).toBe("BLOCKED");
  });
  dispatchIt("keeps the slot while an ordinary task descendant survives its parent", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const ready = join(ctx.home, "descendant-ready"), stop = join(ctx.home, "descendant-stop");
    const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(timer);process.exit(0)}},20);setTimeout(()=>process.exit(0),20000)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:false}).unref()`;
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e", parent], workdir: ctx.home, timeout_seconds: 3 }));
    try {
      expect(cli(...approved(b.epoch, p)).code).toBe(0);
      await waitExit();
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(ready)).toBe(true);
      const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
      expect(tick.code, tick.err).toBe(0);
      expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8")).phase, "[descendant-blocked]").toBe("CLAIMED");
      expect(cli(...approved(b.epoch, p)).value.status).toBe("BLOCKED");
    } finally {
      writeFileSync(stop, "stop");
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, "utf8"));
        let gone = false;
        for (let i = 0; i < 100; i++) {
          try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") { gone = true; break; } }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(gone, `task descendant ${pid} did not stop`).toBe(true);
      }
    }
  }, 12000);
  dispatchIt("lead_completion_cursor_required_before_release", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const reservation = JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8"));
    const exit = JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json.exit"), "utf8"));
    const completion = { id: reservation.id, task: reservation.task.id, status: exit.signal ? "SIGNALED" : "EXITED",
      exit_code: exit.exit_code, signal: exit.signal, event_id: `lead-completion-${reservation.nonce}` };
    const box = new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
    box.send("lead-supervisor", "lead", "DONE", JSON.stringify(completion), null, undefined, completion.event_id);
    const input = JSON.parse(readFileSync(p, "utf8")); input.id = "task-b"; writeFileSync(p, JSON.stringify(input));
    const result = cli(...approved(b.epoch, p));
    if (result.code === 0) await waitExit();
    expect(result.value.status, "[completion-required]").toBe("BLOCKED");
    expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8")).phase).toBe("CLAIMED");
  });
  dispatchIt("refuses a nonpositive completion sequence as consumed proof", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const reservation = JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8"));
    const exit = JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json.exit"), "utf8"));
    const completion = { id: reservation.id, task: reservation.task.id, status: exit.signal ? "SIGNALED" : "EXITED",
      exit_code: exit.exit_code, signal: exit.signal, event_id: `lead-completion-${reservation.nonce}` };
    writeFileSync(join(ctx.home, "messages.jsonl"), JSON.stringify({ seq: 0, id: completion.event_id, ts: new Date().toISOString(),
      from: "lead-supervisor", to: "lead", kind: "DONE", reply_to: null, body: JSON.stringify(completion) }) + "\n");
    const input = JSON.parse(readFileSync(p, "utf8")); input.id = "task-b"; writeFileSync(p, JSON.stringify(input));
    expect(cli(...approved(b.epoch, p)).value.status, "[positive-seq]").toBe("BLOCKED");
    expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8")).phase).toBe("CLAIMED");
  });
  dispatchIt("does not auto-release legacy launch evidence without inherited-group proof", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    for (const suffix of ["gate", "exit"]) {
      const path = join(ctx.home, `lease.json.lead-task.json.${suffix}`), value = JSON.parse(readFileSync(path, "utf8"));
      delete value.process_group;
      writeFileSync(path, JSON.stringify(value));
    }
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.code, tick.err).toBe(0);
    expect(tick.value.completion?.task).toBe("task-a");
    expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8")).phase, "[legacy-gate-blocked]").toBe("CLAIMED");
    expect(cli(...approved(b.epoch, p)).value.status).toBe("BLOCKED");
  });
  it("accepts an occupied receipt written by the previous runtime", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const reservation = { version: 1, id: "invocation-a", nonce: "nonce-a", phase: "RESERVED",
      task: JSON.parse(readFileSync(p, "utf8")), timeout_bin: "/bin/false", holder: "lead-nonce-a", claim_epoch: null,
      task_dir: join(ctx.home, "tasks"), worker_root: join(ctx.home, "workers"), message_path: join(ctx.home, "messages.jsonl"),
      lease_path: join(ctx.home, "lease.json"), lead_session: "session-a", lead_epoch: b.epoch };
    writeFileSync(join(ctx.home, "lease.json.lead-task.json"), JSON.stringify(reservation));
    expect(cli("boot", "--session", "session-a").code).toBe(0);
    const statePath = join(ctx.home, "lease.json.lead.json"), state = JSON.parse(readFileSync(statePath, "utf8"));
    state.receipt.decision.reason = "one approved task slot is occupied; no further dispatch is available";
    writeFileSync(statePath, JSON.stringify(state));
    expect(cli("boot", "--session", "session-a").value.status).toBe("READY");
  });
  dispatchIt("serializes concurrent real-process dispatches into one reservation and launch", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const run = () => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [DIST_CLI, "lead", ...approved(b.epoch, p)], { env: env() });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", (code) => resolve({ code, out }));
    });
    const results = await Promise.all([run(), run(), run()]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 3, 3]);
    expect(results.map((r) => JSON.parse(r.out).status).sort()).toEqual(["BLOCKED", "BLOCKED", "DISPATCHED"]);
    await waitExit();
    expect(JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json.gate"), "utf8")).pid).toBeGreaterThan(1);
  });
  it("reports unsupported timeout without a claim or reservation", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...approved(b.epoch, p)],
      { env: { ...env(), PATH: ctx.home }, encoding: "utf8" });
    expect(JSON.parse(r.stdout).status).toBe("UNAVAILABLE");
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json"))).toBe(false);
  });
  for (const code of [7, 124]) dispatchIt(`publishes actual nonzero exit ${code}`, async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e", `process.exit(${code})`], workdir: ctx.home, timeout_seconds: 2 }));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const result = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value;
    expect(result.completion).toMatchObject({ exit_code: code, status: "EXITED" });
  });
  dispatchIt("uses timeout kill-after for a TERM-resistant child", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], workdir: ctx.home, timeout_seconds: 1 }));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const result = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value;
    expect(["EXITED", "SIGNALED"]).toContain(result.completion.status);
    expect([124, 137, null]).toContain(result.completion.exit_code);
  }, 10000);
  dispatchIt("blocks on corrupt exit identity without publishing completion", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    const exitPath = await waitExit();
    const exit = JSON.parse(readFileSync(exitPath, "utf8"));
    writeFileSync(exitPath, JSON.stringify({ ...exit, nonce: "wrong" }));
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").code).toBe(2);
    expect(existsSync(join(ctx.home, "messages.jsonl"))).toBe(false);
  });
  dispatchIt("replays publication with a stable id after a post-send interruption", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const box = new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
    const original = box.send.bind(box);
    const spy = vi.spyOn(box, "send").mockImplementation((...args) => { original(...args); throw new Error("interrupted after send"); });
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")), box);
    expect(() => loop.run("tick", { session: "session-a", expectedEpoch: b.epoch, tick: 1, approved: true })).toThrow("interrupted after send");
    spy.mockRestore();
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value.events).toHaveLength(1);
    expect(box.all()).toHaveLength(1);
  });
  it("retains a preclaim reservation as a permanent blocker after a crash", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const reservation = { version: 1, id: "invocation-a", nonce: "nonce-a", phase: "RESERVED",
      task: JSON.parse(readFileSync(p, "utf8")), timeout_bin: "/bin/false", holder: "lead-nonce-a", claim_epoch: null,
      task_dir: join(ctx.home, "tasks"), worker_root: join(ctx.home, "workers"), message_path: join(ctx.home, "messages.jsonl"),
      lease_path: join(ctx.home, "lease.json"), lead_session: "session-a", lead_epoch: b.epoch };
    writeFileSync(join(ctx.home, "lease.json.lead-task.json"), JSON.stringify(reservation));
    const retry = spawnSync(process.execPath, [DIST_CLI, "lead", ...approved(b.epoch, p)],
      { env: { ...env(), PATH: ctx.home }, encoding: "utf8" });
    expect(JSON.parse(retry.stdout).status).toBe("BLOCKED");
    expect(existsSync(join(ctx.home, "tasks", "task-a.json"))).toBe(false);
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
  });
  dispatchIt("reconciles exit evidence when worker metadata is missing", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const started = cli(...approved(b.epoch, p));
    expect(started.code).toBe(0);
    await waitExit();
    unlinkSync(join(ctx.home, "workers", started.value.worker, "worker.json"));
    unlinkSync(join(ctx.home, "workers", started.value.worker, "PID"));
    const result = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(result.value.completion.status).toBe("EXITED");
  });
  dispatchIt("keeps the slot blocked when launch exists but exit evidence is absent", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    const exit = await waitExit();
    unlinkSync(exit);
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.value.completion).toBeUndefined();
    expect(tick.value.decision.status).toBe("BLOCKED");
    expect(cli(...approved(b.epoch, p)).value.status).toBe("BLOCKED");
  });
  dispatchIt("honors profile max_workers", () => {
    const profile = `[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = 1\ncompute = "one"\npeople = "solo"\n`;
    writeFileSync(join(ctx.home, "config.toml"), profile);
    const b = cli("boot", "--session", "session-a").value, p = task();
    mkdirSync(join(ctx.home, "workers", "other"), { recursive: true });
    writeFileSync(join(ctx.home, "workers", "other", "PID"), String(process.pid));
    const r = cli(...approved(b.epoch, p));
    expect(r.value.status).toBe("BLOCKED");
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
  });
  dispatchIt("honors the load governor", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    writeFileSync(join(ctx.home, "load.json"), JSON.stringify({ tier: "HIGH" }));
    const r = cli(...approved(b.epoch, p));
    expect(r.value.status).toBe("BLOCKED");
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
  });
  dispatchIt("rejects a role lease that expires during worker preflight", () => {
    const b = cli("boot", "--session", "session-a", "--seconds", "60").value, p = task();
    const box = new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json"), 60, 60), box);
    const clock = vi.spyOn(Date, "now");
    const start = vi.spyOn(Workers.prototype, "start").mockImplementation((_name, options) => {
      clock.mockReturnValue(Date.now() + 61_000);
      options.beforeSpawn?.();
      throw new Error("should not spawn");
    });
    try {
      const [code, value] = loop.dispatch({ session: "session-a", expectedEpoch: b.epoch, approved: true, taskFile: p });
      expect(code).toBe(2);
      expect(value.status).toBe("BLOCKED");
      expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
    } finally { start.mockRestore(); clock.mockRestore(); }
  });
  dispatchIt("reconciles an exited task after its working directory is removed", async () => {
    const dir = join(ctx.home, "workdir"); mkdirSync(dir);
    const b = cli("boot", "--session", "session-a").value, p = task();
    const t = JSON.parse(readFileSync(p, "utf8")); t.workdir = dir; writeFileSync(p, JSON.stringify(t));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit(); rmSync(dir, { recursive: true });
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.value.completion.status).toBe("EXITED");
  });
  dispatchIt("runs a relative workdir with a relative configured lease path", async () => {
    mkdirSync(join(ctx.home, "subdir"));
    writeFileSync(join(ctx.home, "config.toml"), '[lease]\npath = "lease.json"\n');
    const local = (...args: string[]) => {
      const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...args], { cwd: ctx.home, env: env(), encoding: "utf8", timeout: 15000 });
      return { code: r.status, value: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
    };
    const b = local("boot", "--session", "session-a").value, p = task();
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e", "require('fs').writeFileSync('ran.txt','ok')"], workdir: "subdir", timeout_seconds: 2 }));
    const dispatched = local(...approved(b.epoch, p));
    expect(dispatched.code, dispatched.err).toBe(0);
    await waitExit();
    expect(readFileSync(join(ctx.home, "subdir", "ran.txt"), "utf8")).toBe("ok");
    expect(local("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value.completion.exit_code).toBe(0);
  });
  dispatchIt("holds the cursor if matching-epoch claim release fails, then replays once", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const release = vi.spyOn(Tasks.prototype, "release").mockReturnValue([4, { status: "STALE_EPOCH" }]);
    const loop = new LeadLoop(new Lease(join(ctx.home, "lease.json")), new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")));
    const before = readFileSync(join(ctx.home, "lease.json.lead.json"), "utf8");
    try { expect(() => loop.run("tick", { session: "session-a", expectedEpoch: b.epoch, tick: 1, approved: true })).toThrow(); }
    finally { release.mockRestore(); }
    expect(readFileSync(join(ctx.home, "lease.json.lead.json"), "utf8")).toBe(before);
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value.events).toHaveLength(1);
    expect(new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors")).all()).toHaveLength(1);
  });
  it("rejects conflicting content for one stable message id", () => {
    const box = new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
    box.send("lead-supervisor", "lead", "DONE", "first", null, undefined, "fixed-id");
    expect(() => box.send("lead-supervisor", "lead", "DONE", "changed", null, undefined, "fixed-id")).toThrow();
    expect(box.all()).toHaveLength(1);
  });
  dispatchIt("fences a delayed supervisor after role takeover before gate or task launch", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const reserved = cli(...approved(b.epoch, p));
    expect(reserved.code).toBe(0);
    // The first supervisor completes; simulate a second delayed invocation of its same reservation.
    // The gate must be absent so it can only be refused by the current role fence.
    return waitExit().then(() => {
      unlinkSync(join(ctx.home, "lease.json.lead-task.json.gate"));
      const lease = JSON.parse(readFileSync(join(ctx.home, "lease.json"), "utf8"));
      lease.session_id = "session-b"; lease.epoch += 1; writeFileSync(join(ctx.home, "lease.json"), JSON.stringify(lease));
      const reservation = JSON.parse(readFileSync(join(ctx.home, "lease.json.lead-task.json"), "utf8"));
      const supervisor = join(ROOT, "dist", "lead", "supervisor.js");
      const r = spawnSync(process.execPath, [supervisor, Buffer.from(join(ctx.home, "lease.json.lead-task.json")).toString("base64url"), reservation.nonce], { cwd: ctx.home, encoding: "utf8", timeout: 5000 });
      expect(r.status).not.toBe(0);
      expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
    });
  });
  dispatchIt("records completion after its matching claim expires", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const claimPath = join(ctx.home, "tasks", "task-a.json");
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    claim.lease_expires_at = 0;
    writeFileSync(claimPath, JSON.stringify(claim));
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.code, tick.err).toBe(0);
    expect(tick.value.completion.exit_code).toBe(0);
    expect(JSON.parse(readFileSync(claimPath, "utf8")).state).toBe("RELEASED");
  });
  dispatchIt("records a fast task exit when a large brief meets closed stdin", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const input = JSON.parse(readFileSync(p, "utf8")); input.brief = "x".repeat(1024 * 1024);
    writeFileSync(p, JSON.stringify(input));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.code, tick.err).toBe(0);
    expect(tick.value.completion.exit_code).toBe(0);
  });
});
