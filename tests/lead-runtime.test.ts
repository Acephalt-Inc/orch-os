// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Lease } from "../src/lease.js";
import { LeadLoop } from "../src/lead/runtime.js";
import { Messages } from "../src/messages.js";
import { DIST_CLI, useTmpHome } from "./_helpers.js";

describe("lead runtime", () => {
  const ctx = useTmpHome();
  const lease = () => join(ctx.home, "lease.json");
  const state = () => lease() + ".lead.json";
  const messages = () => new Messages(join(ctx.home, "messages.jsonl"), join(ctx.home, "cursors"));
  const env = () => ({ ...process.env, ORCH_HOME: ctx.home });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...args], { env: env(), encoding: "utf8", timeout: 15000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const result = (r: ReturnType<typeof cli>) => { expect(r.code, r.err).toBe(0); return JSON.parse(r.out); };
  const boot = (s: string) => result(cli("boot", "--session", s));
  const tick = (s: string, e: number, n: number) => cli("tick", "--session", s, "--expected-epoch", String(e), "--tick", String(n), "--approved");
  const concurrent = (...argv: string[][]) => Promise.all(argv.map((args) => new Promise<ReturnType<typeof cli>>((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, "lead", ...args], { env: env(), timeout: 15000 });
    let out = "", err = "";
    child.stdout.on("data", (s) => { out += s; }); child.stderr.on("data", (s) => { err += s; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, out, err }));
  })));
  it("boots with durable state and unavailable capabilities", () => {
    const first = boot("session-a");
    expect(first).toMatchObject({ status: "READY", session: "session-a", previous_session: null, boot_count: 1, event_cursor: 0, last_tick: 0,
      capabilities: { scheduler: "UNAVAILABLE", wake: "UNAVAILABLE", memory: "UNAVAILABLE" }, decision: { status: "BLOCKED", reason: expect.any(String) } });
    expect(first.decision.reason.length).toBeGreaterThan(0); expect(first.epoch).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(state(), "utf8"))).toMatchObject({ version: 1, message_path: join(ctx.home, "messages.jsonl"), event_cursor: 0, last_tick: 0, boot_count: 1 });
    expect(boot("session-a")).toMatchObject({ epoch: first.epoch, previous_session: "session-a", boot_count: 2 });
    expect(cli("boot", "--session", "session-b").code).toBe(3);
  });
  it("requires approval and fencing before mutation", () => {
    expect(cli("boot").code).not.toBe(0); expect(existsSync(lease())).toBe(false);
    const b = boot("session-a"); const before = [readFileSync(lease(), "utf8"), readFileSync(state(), "utf8")];
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "1").code).not.toBe(0);
    expect(tick("session-a", b.epoch + 1, 1).code).toBe(4); expect(tick("session-b", b.epoch, 1).code).toBe(4);
    expect(cli("tick", "--session", "session-a", "--expected-epoch", String(b.epoch), "--tick", "0", "--approved").code).not.toBe(0);
    expect([readFileSync(lease(), "utf8"), readFileSync(state(), "utf8")]).toEqual(before);
  });
  it("processes events once without acknowledging them, across restart and takeover", () => {
    const b = boot("session-a"); const box = messages(); const event = box.send("worker", "lead", "DONE", "private body");
    box.send("worker", "other", "DONE", "ignored"); const r = result(tick("session-a", b.epoch, 1));
    expect(r).toMatchObject({ status: "PROCESSED", events: [{ id: event.id, seq: event.seq, kind: "DONE", from: "worker" }] });
    expect(JSON.stringify(r)).not.toContain("private body"); expect(box.pending("lead").map((m) => m.id)).toEqual([event.id]);
    expect(result(tick("session-a", b.epoch, 1))).toMatchObject({ status: "DUPLICATE", events: [] });
    expect(boot("session-a")).toMatchObject({ event_cursor: event.seq, last_tick: 1, boot_count: 2 });
    expect(result(tick("session-a", b.epoch, 2))).toMatchObject({ status: "IDLE", events: [] });
    const l = JSON.parse(readFileSync(lease(), "utf8")); l.lease_expires_at = 0; writeFileSync(lease(), JSON.stringify(l));
    expect(tick("session-a", b.epoch, 3).code).toBe(4); const takeover = boot("session-b");
    expect(takeover).toMatchObject({ previous_session: "session-a", event_cursor: event.seq, last_tick: 2 }); expect(takeover.epoch).toBeGreaterThan(b.epoch);
    expect(result(tick("session-b", takeover.epoch, 3))).toMatchObject({ status: "IDLE", events: [] });
  });
  it("fails closed on corrupt state", () => {
    boot("session-a"); writeFileSync(state(), "broken"); expect(cli("boot", "--session", "session-a").code).toBe(2); expect(readFileSync(state(), "utf8")).toBe("broken");
  });
  it("requires a boot receipt even when another command acquired the lease", () => {
    const role = new Lease(lease());
    const [, acquired] = role.run("acquire", "session-a");
    expect(tick("session-a", acquired.state.epoch, 1).code).toBe(2);
    expect(existsSync(state())).toBe(false);
  });
  it("does not commit if the lease expires during event inspection", () => {
    const role = new Lease(lease(), 60, 60);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const box = messages();
      const loop = new LeadLoop(role, box);
      const [, b] = loop.run("boot", { session: "session-a" });
      box.send("worker", "lead", "DONE", "finished");
      const inbox = box.inbox.bind(box);
      box.inbox = (reader) => { const events = inbox(reader); now += 61_000; return events; };
      const before = readFileSync(state(), "utf8");
      expect(loop.run("tick", { session: "session-a", expectedEpoch: b.epoch, tick: 1, approved: true })[0]).toBe(4);
      expect(readFileSync(state(), "utf8")).toBe(before);
    } finally { clock.mockRestore(); }
  });
  it("refuses an incomplete saved receipt before changing the lease", () => {
    boot("session-a");
    const saved = JSON.parse(readFileSync(state(), "utf8"));
    delete saved.receipt.status;
    writeFileSync(state(), JSON.stringify(saved));
    const before = [readFileSync(state(), "utf8"), readFileSync(lease(), "utf8")];
    expect(cli("boot", "--session", "session-a").code).toBe(2);
    expect([readFileSync(state(), "utf8"), readFileSync(lease(), "utf8")]).toEqual(before);
  });
  it("refuses a rewound log even when retrying an already committed tick", () => {
    const b = boot("session-a");
    messages().send("worker", "lead", "DONE", "finished");
    result(tick("session-a", b.epoch, 1));
    writeFileSync(messages().path, "");
    const before = readFileSync(state(), "utf8");
    expect(tick("session-a", b.epoch, 1).code).toBe(2);
    expect(readFileSync(state(), "utf8")).toBe(before);
  });
  it.each(["unsafe sequence", "duplicate sequence", "empty id"])("refuses invalid event metadata: %s", (fault) => {
    const b = boot("session-a");
    const event = { seq: fault === "unsafe sequence" ? Number.MAX_SAFE_INTEGER + 1 : 1,
      id: fault === "empty id" ? "" : "event-a", kind: "DONE", from: "worker", to: "lead", body: "finished" };
    writeFileSync(messages().path, JSON.stringify(event) + "\n" +
      (fault === "duplicate sequence" ? JSON.stringify({ ...event, id: "event-b" }) + "\n" : ""));
    const before = readFileSync(state(), "utf8");
    expect(tick("session-a", b.epoch, 1).code).toBe(2);
    expect(readFileSync(state(), "utf8")).toBe(before);
  });
  it("rejects a changed configured message path without resetting state", () => {
    boot("session-a");
    const before = readFileSync(state(), "utf8");
    writeFileSync(join(ctx.home, "config.toml"), `[messages]\npath = ${JSON.stringify(join(ctx.home, "other.jsonl"))}\n`);
    expect(cli("boot", "--session", "session-a").code).toBe(2);
    expect(readFileSync(state(), "utf8")).toBe(before);
  });
  it("limits each tick to 100 addressed events", () => {
    const b = boot("session-a"); const box = messages();
    for (let i = 0; i < 101; i++) box.send("worker", "lead", "DONE", `event ${i}`);
    expect(result(tick("session-a", b.epoch, 1)).events).toHaveLength(100);
    expect(result(tick("session-a", b.epoch, 2)).events).toHaveLength(1);
  });
  it("serializes competing boots and duplicate ticks in real processes", async () => {
    const boots = await concurrent(["boot", "--session", "session-a"], ["boot", "--session", "session-b"]);
    expect(boots.map((r) => r.code).sort()).toEqual([0, 3]); const winner = result(boots.find((r) => r.code === 0)!);
    const event = messages().send("worker", "lead", "DONE", "body");
    const args = ["tick", "--session", winner.session, "--expected-epoch", String(winner.epoch), "--tick", "1", "--approved"];
    const ticks = (await concurrent(args, args, args)).map(result);
    expect(ticks.map((r) => r.status).sort()).toEqual(["DUPLICATE", "DUPLICATE", "PROCESSED"]);
    expect(ticks.find((r) => r.status === "PROCESSED").events).toEqual([{ id: event.id, seq: event.seq, kind: "DONE", from: "worker" }]);
    expect(result(tick(winner.session, winner.epoch, 2))).toMatchObject({ status: "IDLE", events: [] });
  });
});
