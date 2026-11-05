import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Messages } from "../src/messages.js";
import { WakeWatch, workerSnapshot } from "../src/service/wake.js";
import { tmp } from "./_helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup() {
  const home = tmp(); roots.push(home);
  return { home, messages: new Messages(join(home, "messages.jsonl"), join(home, "cursors")) };
}
const records = (home: string) => readFileSync(join(home, "wake", "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("wake-watch", () => {
  it("logs addressed events and worker exits once across a restart without acknowledging messages", () => {
    const { home, messages } = setup();
    const q = messages.send("worker", "lead", "QUESTION", "first\nsecond");
    messages.send("worker", "other", "BLOCKED", "private");
    messages.send("worker", "*", "DONE", "done");
    messages.send("lead", "*", "DONE", "self broadcast");
    messages.send("worker", "lead", "ANSWER", "answer", q.id);
    let state = "RUNNING";
    const workers = () => [{ name: "w1", run: "12:100", state }];
    expect(new WakeWatch(home, messages, "lead", workers).tick()).toBe(2);
    state = "STOPPED";
    expect(new WakeWatch(home, messages, "lead", workers).tick()).toBe(1);
    expect(new WakeWatch(home, messages, "lead", workers).tick()).toBe(0);
    expect(records(home).map((r) => r.kind)).toEqual(["QUESTION", "DONE", "WORKER_EXIT"]);
    expect(messages.pending("lead")).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(home, "wake", "cursor.json"), "utf8")).seq).toBe(5);
    state = "STOPPED";
    expect(new WakeWatch(home, messages, "lead", () => [{ name: "w1", run: "13:200", state }]).tick()).toBe(1);
  });
  it("recovers after append-before-cursor interruption without duplicates", () => {
    const { home, messages } = setup();
    messages.send("worker", "lead", "BLOCKED", "blocked");
    new WakeWatch(home, messages, "lead", () => []).tick();
    writeFileSync(join(home, "wake", "cursor.json"), JSON.stringify({ seq: 0 }));
    expect(new WakeWatch(home, messages, "lead", () => []).tick()).toBe(0);
    expect(records(home)).toHaveLength(1);
  });
  it("separates a complete final event whose newline was interrupted", () => {
    const { home, messages } = setup(); messages.send("w", "lead", "DONE", "first");
    new WakeWatch(home, messages, "lead", () => []).tick();
    const log = join(home, "wake", "events.log"); writeFileSync(log, readFileSync(log, "utf8").trimEnd());
    messages.send("w", "lead", "DONE", "second"); new WakeWatch(home, messages, "lead", () => []).tick();
    expect(records(home)).toHaveLength(2);
    expect(new WakeWatch(home, messages, "lead", () => []).tick()).toBe(0);
  });
  it("preserves foreign and replaced wake files", () => {
    const { home, messages } = setup(); mkdirSync(join(home, "wake"));
    const log = join(home, "wake", "events.log"); writeFileSync(log, "user note");
    expect(() => new WakeWatch(home, messages, "lead", () => []).tick()).toThrow("unowned");
    expect(readFileSync(log, "utf8")).toBe("user note");
    rmSync(log); new WakeWatch(home, messages, "lead", () => []).tick();
    const target = join(home, "user.txt"); writeFileSync(target, "keep me"); rmSync(log);
    symlinkSync(target, log);
    expect(() => new WakeWatch(home, messages, "lead", () => []).tick()).toThrow("symbolic");
    expect(readFileSync(target, "utf8")).toBe("keep me");
    rmSync(log); symlinkSync(join(home, "missing"), log);
    expect(() => new WakeWatch(home, messages, "lead", () => []).tick()).toThrow("symbolic");
  });
  it("does not advance on worker snapshot failure", () => {
    const { home, messages } = setup();
    messages.send("worker", "lead", "DONE", "done");
    expect(() => new WakeWatch(home, messages, "lead", () => { throw new Error("probe failed"); }).tick()).toThrow("probe failed");
    expect(existsSync(join(home, "wake", "cursor.json"))).toBe(false);
  });
  it("fails closed on corrupt durable state", () => {
    const { home, messages } = setup(); mkdirSync(join(home, "wake"));
    writeFileSync(join(home, "wake", "cursor.json"), "bad");
    expect(() => new WakeWatch(home, messages, "lead", () => []).tick()).toThrow();
  });
  it("uses injected process evidence including live process-group descendants", () => {
    const { home } = setup(); const root = join(home, "workers", "w1"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "worker.json"), JSON.stringify({ pid: 12, started_at: 100 }));
    const calls: unknown[] = [];
    const runner = (cmd: string, args: string[]) => { calls.push([cmd, args]); return { code: 0, out: "13 12 S\n", err: "" }; };
    expect(workerSnapshot(join(home, "workers"), "darwin", runner)).toEqual([{ name: "w1", run: "12:100", state: "RUNNING" }]);
    expect(calls).toHaveLength(1);
    expect(() => workerSnapshot(join(home, "workers"), "darwin", () => ({ code: 1, out: "", err: "denied" }))).toThrow("denied");
    writeFileSync(join(root, "worker.json"), JSON.stringify({ pid: 12, started_at: 100, proc_start: "Mon Nov  2 09:00:00 2026" }));
    expect(workerSnapshot(join(home, "workers"), "darwin", () => ({ code: 0, out: "12 12 S Tue Nov  3 09:00:00 2026\n", err: "" }))[0].state).toBe("STOPPED");
    expect(workerSnapshot(join(home, "workers"), "win32", () => ({ code: 0, out: "[12]", err: "" }))[0].state).toBe("RUNNING");
  });
});
