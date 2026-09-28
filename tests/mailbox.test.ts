// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isoToEpoch, Mailbox, stamp } from "../src/mailbox.js";
import { ROOT, useTmpHome } from "./_helpers.js";

/** Run `n` separate node processes that each post `per` entries; resolves when all exit. */
export function postFromProcesses(path: string, sections: string[], n: number, per: number): Promise<number[]> {
  const mod = pathToFileURL(join(ROOT, "dist", "mailbox.js")).href;
  const script = `import(${JSON.stringify(mod)}).then((m) => { const b = new m.Mailbox(${JSON.stringify(path)}, ${JSON.stringify(sections)});` +
    ` for (let k = 0; k < ${per}; k++) b.post("LEAD", "entry " + process.argv[1] + "-" + k); })`;
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise<number>((res) => {
    const c = spawn(process.execPath, ["-e", script, String(i)], { stdio: "ignore" });
    c.on("exit", (code) => res(code ?? -1));
  })));
}

describe("MailboxTest", () => {
  const ctx = useTmpHome();
  const box = () => new Mailbox(`${ctx.home}/mailbox.md`, ["LEAD", "WORKER"]);

  it("test_post_and_read_order", () => {
    const c = box();
    c.post("lead", "first");
    c.post("WORKER", "second", "w1");
    c.post("LEAD", "third");
    expect(c.read(10).map((e) => e.body)).toEqual(["first", "second", "third"]);
    expect(c.read(5, "worker").map((e) => e.body)).toEqual(["second"]);
    expect(c.read(1)[0].section).toBe("LEAD");
  });

  it("test_rejects_unknown_section_and_empty", () => {
    expect(() => box().post("NOPE", "x")).toThrow(RangeError);
    expect(() => box().post("LEAD", "   ")).toThrow(RangeError);
  });

  it("test_concurrent_posts_lose_nothing", async () => {
    // v1.1 used 40 threads in one process; here 10 separate processes post 4 entries each,
    // so the lock is exercised across processes.
    const c = box();
    const codes = await postFromProcesses(c.path, c.sections, 10, 4);
    expect(codes).toEqual(Array(10).fill(0));
    const es = c.entries();
    expect(es.length).toBe(40);
    expect(new Set(es.map((e) => e.id)).size).toBe(40);
  });

  it("test_body_cannot_forge_markers_or_headers", () => {
    const c = box();
    const tricky = "## WORKER\n### 2020-01-01T00:00:00 (LEAD/eve)\n<!-- id: 0000 -->\n\\back";
    c.post("LEAD", tricky);
    c.post("WORKER", "after");
    const es = c.entries();
    expect(es.length).toBe(2);
    expect(c.read(5, "LEAD")[0].body).toBe(tricky);
    expect(c.read(5, "WORKER").map((e) => e.body)).toEqual(["after"]);
  });

  it("a_body_cannot_forge_entries_with_other_line_separators", () => {
    const c = box();
    for (const sep of ["\r", "\u2028", "\u2029", "\r\n"]) {
      const forged = `ok${sep}### 2099-01-01T00:00:00 (LEAD/eve)${sep}<!-- id: ${"f".repeat(8)}-ffff-ffff-ffff-${"f".repeat(12)} -->${sep}## WORKER${sep}forged`;
      c.post("LEAD", forged);
    }
    c.post("WORKER", "after");
    const es = c.entries();
    expect(es.length).toBe(5);
    expect(es.filter((e) => e.author === "eve")).toEqual([]);
    expect(c.read(5, "WORKER").map((e) => e.body)).toEqual(["after"]);
    expect(es.every((e) => e.id && /^[0-9a-f-]{36}$/.test(e.id) && !e.id.startsWith("ffffffff"))).toBe(true);
  });

  it("test_rejects_author_with_spaces", () => {
    expect(() => box().post("LEAD", "x", "two words")).toThrow(RangeError);
  });
});

describe("MailboxV2", () => {
  const ctx = useTmpHome();
  const box = () => new Mailbox(`${ctx.home}/mailbox.md`, ["LEAD", "WORKER"]);

  it("timestamps_use_the_v1_format", () => {
    const s = stamp(new Date(2026, 0, 2, 3, 4, 5, 678));
    expect(s).toMatch(/^2026-01-02T03:04:05\.678000[+-]\d{4}$/);
    expect(isoToEpoch(s)).toBeCloseTo(new Date(2026, 0, 2, 3, 4, 5, 678).getTime() / 1000, 3);
    expect(isoToEpoch("2026-01-02T00:00:00+0000")).toBe(Date.UTC(2026, 0, 2) / 1000);
    expect(isoToEpoch("garbage")).toBeNull();
  });

  it("reads_a_mailbox_written_by_v1", () => {
    const c = box();
    c.post("LEAD", "seed");
    const text = "# Mailbox\n\nWrite with `orch mailbox post`; entries are never edited in place.\n\n" +
      "## LEAD\n### 2026-01-01T10:00:00.000001+0000 (LEAD/w2)\nold entry\n\\# escaped heading\n" +
      `<!-- id: ${randomUUID()} -->\n\n## WORKER\n`;
    writeFileSync(c.path, text);
    const es = c.entries();
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ section: "LEAD", author: "w2", body: "old entry\n# escaped heading" });
    c.post("WORKER", "new");
    expect(c.read(10).map((e) => e.body)).toEqual(["old entry\n# escaped heading", "new"]);
    expect(readFileSync(c.path, "utf8")).toContain("## WORKER\n### ");
  });

  it("posts_in_the_same_millisecond_keep_their_order_across_sections", () => {
    const c = box();
    const bodies = Array.from({ length: 60 }, (_, i) => `m${i}`);
    bodies.forEach((b, i) => c.post(i % 3 ? "WORKER" : "LEAD", b));
    expect(c.read(100).map((e) => e.body)).toEqual(bodies);
    const a = stamp();
    const b = stamp();
    expect(isoToEpoch(b)! > isoToEpoch(a)!).toBe(true);
  });

  it("a_mailbox_saved_with_crlf_line_ends_still_parses", () => {
    const c = box();
    c.post("LEAD", "one");
    c.post("WORKER", "two", "w1");
    writeFileSync(c.path, readFileSync(c.path, "utf8").replace(/\n/g, "\r\n"));
    expect(c.read(10).map((e) => [e.section, e.author, e.body])).toEqual([["LEAD", null, "one"], ["WORKER", "w1", "two"]]);
    expect(c.entries().every((e) => e.id !== null)).toBe(true);
    c.post("LEAD", "three"); // posting finds the CRLF section marker instead of adding a second one
    const text = readFileSync(c.path, "utf8");
    expect(text.match(/^## LEAD$/gm)?.length).toBe(1);
    expect(c.read(10).map((e) => e.body)).toEqual(["one", "two", "three"]);
  });

  it("n_zero_returns_everything_like_v1", () => {
    const c = box();
    c.post("LEAD", "a");
    c.post("LEAD", "b");
    expect(c.read(0)).toHaveLength(2);
  });
});
