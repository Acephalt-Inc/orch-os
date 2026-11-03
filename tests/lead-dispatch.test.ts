import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Lease } from "../src/lease.js";
import { LeadLoop } from "../src/lead/runtime.js";
import { Messages } from "../src/messages.js";
import { Workers } from "../src/workers.js";
import { Tasks } from "../src/tasks.js";
import { DIST_CLI, ROOT, useTmpHome } from "./_helpers.js";

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
    if (!gone) appendFileSync(join(ROOT, "../OUT/slice2-unresolved-pids.log"), `${pid} ${ctx.home}\n`);
    expect(gone, `supervisor ${pid} was not observed to exit`).toBe(true);
    return exit;
  };
  it("rejects missing approval and invalid timeout before reserving or claiming", () => {
    const b = cli("boot", "--session", "session-a").value;
    const p = task(0);
    expect(cli("dispatch", "--session", "session-a", "--expected-epoch", String(b.epoch), "--task-file", p, "--approved").code).toBe(2);
    task();
    expect(cli("dispatch", "--session", "session-a", "--expected-epoch", String(b.epoch), "--task-file", p).code).toBe(2);
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json"))).toBe(false);
    expect(existsSync(join(ctx.home, "tasks", "task-a.json"))).toBe(false);
  });
  it("reserves one task, publishes verified exit on tick, and blocks a second dispatch", async () => {
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
  it("serializes concurrent real-process dispatches into one reservation and launch", async () => {
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
  it.each([7, 124])("publishes actual nonzero exit %i", async (code) => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e", `process.exit(${code})`], workdir: ctx.home, timeout_seconds: 2 }));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const result = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value;
    expect(result.completion).toMatchObject({ exit_code: code, status: "EXITED" });
  });
  it("uses GNU timeout kill-after for a TERM-resistant child", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    writeFileSync(p, JSON.stringify({ id: "task-a", brief: "generic task", command: [process.execPath, "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], workdir: ctx.home, timeout_seconds: 1 }));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit();
    const result = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").value;
    expect(["EXITED", "SIGNALED"]).toContain(result.completion.status);
    expect([124, 137, null]).toContain(result.completion.exit_code);
  }, 10000);
  it("blocks on corrupt exit identity without publishing completion", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    const exitPath = await waitExit();
    const exit = JSON.parse(readFileSync(exitPath, "utf8"));
    writeFileSync(exitPath, JSON.stringify({ ...exit, nonce: "wrong" }));
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved").code).toBe(2);
    expect(existsSync(join(ctx.home, "messages.jsonl"))).toBe(false);
  });
  it("replays publication with a stable id after a post-send interruption", async () => {
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
    expect(cli(...approved(b.epoch, p)).value.status).toBe("BLOCKED");
    expect(existsSync(join(ctx.home, "tasks", "task-a.json"))).toBe(false);
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
  });
  it("reconciles exit evidence when worker metadata is missing", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    const started = cli(...approved(b.epoch, p));
    expect(started.code).toBe(0);
    await waitExit();
    unlinkSync(join(ctx.home, "workers", started.value.worker, "worker.json"));
    unlinkSync(join(ctx.home, "workers", started.value.worker, "PID"));
    const result = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(result.value.completion.status).toBe("EXITED");
  });
  it("keeps the slot blocked when launch exists but exit evidence is absent", async () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    const exit = await waitExit();
    unlinkSync(exit);
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.value.completion).toBeUndefined();
    expect(tick.value.decision.status).toBe("BLOCKED");
    expect(cli(...approved(b.epoch, p)).value.status).toBe("BLOCKED");
  });
  it("honors profile max_workers", () => {
    const profile = `[profile]\npolicy = "human-merge"\nrequired_review = "single-agent"\nmax_workers = 1\ncompute = "one"\npeople = "solo"\n`;
    writeFileSync(join(ctx.home, "config.toml"), profile);
    const b = cli("boot", "--session", "session-a").value, p = task();
    mkdirSync(join(ctx.home, "workers", "other"), { recursive: true });
    writeFileSync(join(ctx.home, "workers", "other", "PID"), String(process.pid));
    const r = cli(...approved(b.epoch, p));
    expect(r.value.status).toBe("BLOCKED");
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
  });
  it("honors the load governor", () => {
    const b = cli("boot", "--session", "session-a").value, p = task();
    writeFileSync(join(ctx.home, "load.json"), JSON.stringify({ tier: "HIGH" }));
    const r = cli(...approved(b.epoch, p));
    expect(r.value.status).toBe("BLOCKED");
    expect(existsSync(join(ctx.home, "lease.json.lead-task.json.gate"))).toBe(false);
  });
  it("rejects a role lease that expires during worker preflight", () => {
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
  it("reconciles an exited task after its working directory is removed", async () => {
    const dir = join(ctx.home, "workdir"); mkdirSync(dir);
    const b = cli("boot", "--session", "session-a").value, p = task();
    const t = JSON.parse(readFileSync(p, "utf8")); t.workdir = dir; writeFileSync(p, JSON.stringify(t));
    expect(cli(...approved(b.epoch, p)).code).toBe(0);
    await waitExit(); rmSync(dir, { recursive: true });
    const tick = cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1", "--approved");
    expect(tick.value.completion.status).toBe("EXITED");
  });
  it("runs a relative workdir with a relative configured lease path", async () => {
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
  it("holds the cursor if matching-epoch claim release fails, then replays once", async () => {
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
  it("fences a delayed supervisor after role takeover before gate or task launch", () => {
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
  it("records completion after its matching claim expires", async () => {
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
  it("records a fast task exit when a large brief meets closed stdin", async () => {
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
