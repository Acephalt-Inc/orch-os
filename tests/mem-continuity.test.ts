// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Mem } from "../src/mem.js";
import { captureHook } from "../src/mem-capture.js";
import { run, runStdin, useTmpHome } from "./_helpers.js";

describe("session memory continuity", () => {
  const ctx = useTmpHome();
  const event = (session_id = "session-a", hook_event_name = "SessionEnd", cwd?: string) => ({
    hook_event_name, session_id, transcript_path: join(ctx.home, "transcript.jsonl"), ...(cwd ? { cwd } : {}),
  });
  const transcript = () => writeFileSync(join(ctx.home, "transcript.jsonl"), [
    { type: "user", message: { role: "user", content: "Build the first report" } },
    { type: "assistant", message: { role: "assistant", content: "secret assistant output" } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "secret tool output" }, { type: "text", text: "Review the first report" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "synthetic metadata" } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");

  it("captures text-only draft, accepts it, then boot and lint apply dates", async () => {
    await run("init", "--no-handbook");
    transcript();
    const [code, out, err] = await runStdin(JSON.stringify(event()), "mem", "capture", "--from-hook");
    expect(code, err).toBe(0);
    const id = `session-${createHash("sha256").update("session-a").digest("hex")}`;
    expect(out).toContain(id);
    const m = new Mem(join(ctx.home, "mem"));
    expect(m.get(id)).toMatchObject({ status: "draft", description: "Build the first report" });
    expect(m.get(id)?.body).toContain("Review the first report");
    expect(m.get(id)?.body).not.toMatch(/secret|synthetic/);
    expect(m.search([])).toEqual([]);
    expect((await run("mem", "drafts"))[1]).toContain(`${id} draft, unverified`);
    expect(readFileSync(join(ctx.home, "mem", "INDEX.md"), "utf8")).not.toContain(id);
    expect((await run("mem", "recall", "--boot"))[1]).toMatch(/draft, unverified/);
    expect((await run("mem", "accept", id, "--title", "Report process"))[0]).toBe(0);
    expect((await run("mem", "drafts"))[1]).not.toContain(id);
    expect(m.get(id)).toMatchObject({ status: "active", title: "Report process" });
    expect(m.get(id)?.verified).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect((await run("mem", "recall", "--boot"))[1]).toContain("Report process");
    expect((await run("mem", "recall", "--boot"))[1]).not.toContain("Review the first report");
    const file = m.file(id);
    writeFileSync(file, readFileSync(file, "utf8").replace("status: active", "status: active\nexpires: 2000-01-01"));
    expect((await run("mem", "lint"))[0]).toBe(2);
    expect((await run("mem", "recall", "--boot"))[1]).not.toContain("Report process");
  });

  it("rejects a draft permanently and ignores repeated hooks", async () => {
    await run("init", "--no-handbook");
    transcript();
    const [code, out] = await runStdin(JSON.stringify(event("session-b", "PreCompact")), "mem", "capture", "--from-hook");
    expect(code).toBe(0);
    const id = out.match(/session-[a-f0-9]{64}/)![0];
    expect((await run("mem", "reject", id))[0]).toBe(0);
    expect((await run("mem", "drafts"))[1]).not.toContain(id);
    expect((await runStdin(JSON.stringify(event("session-b", "PreCompact")), "mem", "capture", "--from-hook"))[0]).toBe(0);
    expect(new Mem(join(ctx.home, "mem")).get(id)?.status).toBe("rejected");
    expect((await run("mem", "search", "--all", id))[0]).toBe(0);
    expect((await run("mem", "recall", "--boot"))[1]).not.toContain(id);
  });

  it("reject removes captured user and resume text even from all-search JSON", async () => {
    await run("init", "--no-handbook");
    const m = new Mem(join(ctx.home, "mem"));
    const entry = captureHook(event("private", "SessionEnd", ctx.home), m, { list: () => [] }, {
      read: () => JSON.stringify({ type: "user", message: { role: "user", content: "Sensitive user request" } }),
      resumeShow: () => ({ schema: 1, id: "note", revision: 1, saved_at: "2026-01-01T00:00:00Z", note: { objective: "", reported_progress: "", next_step: "Sensitive next step" } }),
    });
    expect(entry.body).toContain("Sensitive next step");
    expect((await run("mem", "reject", entry.name))[0]).toBe(0);
    const saved = m.get(entry.name)!;
    expect(saved).toMatchObject({ status: "rejected", description: "Rejected session draft", body: "", session_hash: entry.session_hash });
    expect(readFileSync(saved.file, "utf8")).not.toMatch(/Sensitive user request|Sensitive next step/);
    const [code, out] = await run("mem", "search", "--all", entry.name, "--json");
    expect(code).toBe(0);
    expect(out).not.toMatch(/Sensitive user request|Sensitive next step/);
  });

  it("repeat hook returns the owned record without reopening unavailable dependencies", () => {
    const m = new Mem(join(ctx.home, "mem"));
    const hook = event("retry", "PreCompact", ctx.home);
    const prior = captureHook(hook, m, { list: () => [] }, {
      read: () => JSON.stringify({ type: "user", message: { role: "user", content: "Initial request" } }),
      resumeShow: () => ({ schema: 1, id: "note", revision: 1, saved_at: "2026-01-01T00:00:00Z", note: { objective: "", reported_progress: "", next_step: "Initial step" } }),
    });
    m.accept(prior.name, "Accepted title");
    let calls = 0;
    const unavailable = () => { calls++; throw new Error("unavailable"); };
    const repeated = captureHook(hook, m, { list: unavailable }, { read: unavailable, resumeShow: unavailable });
    expect(repeated).toEqual(m.get(prior.name));
    expect(repeated.status).toBe("active");
    expect(calls).toBe(0);
  });

  it("validates hook before writing and preserves Windows drive and UNC paths", async () => {
    await run("init", "--no-handbook");
    expect((await runStdin(JSON.stringify({ ...event(), hook_event_name: "Stop" }), "mem", "capture", "--from-hook"))[0]).toBe(2);
    expect((await runStdin("bad json", "mem", "capture", "--from-hook"))[0]).toBe(2);
    expect((await run("mem", "capture"))[0]).toBe(2);
    expect(new Mem(join(ctx.home, "mem")).all()).toEqual([]);
    const m = new Mem(join(ctx.home, "mem"));
    const paths: string[] = [];
    for (const p of ["C:\\logs\\session.jsonl", "\\\\server\\share\\session.jsonl"]) {
      captureHook({ hook_event_name: "SessionEnd", session_id: p, transcript_path: p }, m, { list: () => [] }, {
        platform: "win32", read: (path) => { paths.push(path); return JSON.stringify({ type: "user", message: { role: "user", content: "A request" } }); },
      });
    }
    expect(paths).toEqual(["C:\\logs\\session.jsonl", "\\\\server\\share\\session.jsonl"]);
    expect(() => captureHook({ hook_event_name: "SessionEnd", session_id: "foreign", transcript_path: "C:\\logs\\session.jsonl" }, m, { list: () => [] }, { platform: "darwin", read: () => { throw new Error("must not read"); } })).toThrow();
    expect(() => captureHook({ hook_event_name: "SessionEnd", session_id: "relative", transcript_path: "\\logs\\session.jsonl" }, m, { list: () => [] }, { platform: "win32", read: () => { throw new Error("must not read"); } })).toThrow();
    expect(() => captureHook(event("unsafe", "SessionEnd", ctx.home), m, { list: () => [] }, { read: () => "", resumeShow: () => { throw new Error("unsafe workspace"); } })).toThrow(/resume workspace is unsafe/);
  });

  it("keeps only bounded user text, task states and explicitly unverified resume next step", () => {
    const m = new Mem(join(ctx.home, "mem"));
    const lines = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Plan the work <system-reminder>injected system text</system-reminder>" }, { type: "tool_result", content: "tool secret" }] } },
      { type: "user", isMeta: true, message: { role: "user", content: "meta secret" } },
      { type: "user", isCompactSummary: true, message: { role: "user", content: "compact summary secret" } },
      { type: "user", message: { role: "user", content: [{ type: "file", text: "file attachment secret" }] } },
      ...Array.from({ length: 12 }, (_, i) => ({ type: "user", message: { role: "user", content: `Request ${i} ${"x".repeat(800)}` } })),
    ];
    const text = lines.map((x) => JSON.stringify(x)).join("\n");
    const entry = captureHook({ ...event("bounded", "PreCompact", ctx.home) }, m,
      { list: () => [{ id: "task-one", status: "CLAIMED", holder: null, epoch: 1, expires_in: 20 }, { id: "old", status: "RELEASED", holder: null, epoch: 1, expires_in: 0 }] },
      { platform: process.platform, read: () => text, resumeShow: () => ({ schema: 1, id: "note", revision: 1, saved_at: "2026-01-01T00:00:00Z", note: { objective: "objective secret", reported_progress: "progress secret", next_step: "Check result" } }) });
    expect(entry.body).toContain("task-one: CLAIMED");
    expect(entry.body).toContain("Unverified next step (private resume note): Check result");
    expect(entry.body).toContain("Request 8");
    expect(entry.body).not.toMatch(/Request 9|Request 11|tool secret|meta secret|compact summary secret|file attachment secret|injected system text|objective secret|progress secret|old: RELEASED/);
    expect(entry.body.length).toBeLessThan(6_000);
  });

  it("refuses occupied unknown paths and retains metadata through acceptance and retirement", () => {
    const m = new Mem(join(ctx.home, "mem"));
    const id = `session-${createHash("sha256").update("safe").digest("hex")}`;
    mkdirSync(m.dir);
    writeFileSync(m.file(id), "foreign content");
    expect(() => m.draft(id, "description", "body", id.slice(8))).toThrow(/occupied/);
    expect(readFileSync(m.file(id), "utf8")).toBe("foreign content");
    const other = `session-${createHash("sha256").update("other").digest("hex")}`;
    m.draft(other, "description", "body", other.slice(8), new Date("2025-01-01T00:00:00Z"));
    let file = m.file(other);
    writeFileSync(file, readFileSync(file, "utf8").replace("status: draft", "status: draft\nexpires: 2099-01-01\nsuperseded_by: later"));
    m.accept(other, "A title", new Date("2026-01-01T00:00:00Z"));
    expect(m.get(other)).toMatchObject({ expires: "2099-01-01", superseded_by: "later", verified: "2026-01-01" });
    m.retire(other, undefined, "old", new Date("2026-02-01T00:00:00Z"));
    expect(m.get(other)).toMatchObject({ status: "retired", expires: "2099-01-01", verified: "2026-01-01" });
    expect(m.lint(new Date("2026-02-01T00:00:00Z")).map((r) => r.entry.name)).toContain(other);
    if (process.platform !== "win32") {
      const link = `session-${createHash("sha256").update("link").digest("hex")}`;
      symlinkSync(file, m.file(link));
      expect(() => m.draft(link, "description", "body", link.slice(8))).toThrow(/occupied/);
      expect(() => m.accept(link)).toThrow();
    }
  });

  it("boot sorts newest accepted notes, limits them, and shows only the newest draft", () => {
    const m = new Mem(join(ctx.home, "mem"));
    const now = new Date();
    for (let i = 9; i >= 0; i--) m.add(`n${i}`, `description ${i}`, `private body ${i}`, "note", new Date(now.getTime() - i * 60_000));
    const a = createHash("sha256").update("draft-a").digest("hex");
    const b = createHash("sha256").update("draft-b").digest("hex");
    m.draft(`session-${a}`, "older draft", "body", a, new Date(now.getTime() - 3000));
    m.draft(`session-${b}`, "newer draft", "body", b, now);
    const stale = createHash("sha256").update("draft-stale").digest("hex");
    m.draft(`session-${stale}`, "stale draft", "body", stale, new Date(now.getTime() - 100 * 86400000));
    expect(m.lint(now).map((r) => r.entry.name)).toContain(`session-${stale}`);
    expect(m.boot(2, now).accepted.map((e) => e.name)).toEqual(["n0", "n1"]);
    expect(m.boot(2, now).draft?.name).toBe(`session-${b}`);
    expect(m.boot(undefined, now).accepted).toHaveLength(8);
    expect(m.boot(20, now).accepted).toHaveLength(10);
    expect(() => m.boot(21, now)).toThrow(/1 through 20/);
  });

  it("CLI lint and boot honor age config, invalid dates, expiry and supersession", async () => {
    await run("init", "--no-handbook");
    const config = join(ctx.home, "config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("index_max_lines = 200", "index_max_lines = 200\nunverified_max_days = 1"));
    const m = new Mem(join(ctx.home, "mem"));
    const old = new Date(Date.now() - 2 * 86400000);
    m.add("stale", "stale description", "", "note", old);
    m.add("expired", "expired description", "");
    m.add("superseded", "superseded description", "");
    m.add("bad-date", "invalid date description", "");
    writeFileSync(m.file("expired"), readFileSync(m.file("expired"), "utf8").replace("status: active", "status: active\nexpires: 2000-01-01"));
    writeFileSync(m.file("superseded"), readFileSync(m.file("superseded"), "utf8").replace("status: active", "status: active\nsuperseded_by: newer"));
    writeFileSync(m.file("bad-date"), readFileSync(m.file("bad-date"), "utf8").replace(/created_at: .+/, "created_at: invalid"));
    const [code, out] = await run("mem", "lint");
    expect(code).toBe(2);
    expect(out).toMatch(/stale: unverified too long/);
    expect(out).toMatch(/expired: expired/);
    expect(out).toMatch(/superseded: superseded/);
    expect(out).toMatch(/bad-date: invalid created date/);
    const boot = (await run("mem", "recall", "--boot"))[1];
    expect(boot).not.toMatch(/stale description|expired description|superseded description|invalid date description/);
    writeFileSync(m.file("stale"), readFileSync(m.file("stale"), "utf8").replace("status: active", `status: active\nverified: ${new Date().toISOString().slice(0, 10)}`));
    expect((await run("mem", "recall", "--boot"))[1]).toContain("stale description");
  });
});
