// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Mem, MemError, parseEntry } from "../src/mem.js";
import { run, runStdin, useTmpHome } from "./_helpers.js";

describe("MemV2", () => {
  const ctx = useTmpHome();
  const store = (cap = 200) => new Mem(`${ctx.home}/mem`, cap);

  it("add_writes_one_file_with_frontmatter_and_an_index_line", () => {
    const r = store().add("verify-before-claiming", "Show the command output before saying done.", "Why: a claim without output was wrong twice.", "rule");
    const text = readFileSync(`${ctx.home}/mem/verify-before-claiming.md`, "utf8");
    expect(text).toMatch(/^---\nname: verify-before-claiming\ndescription: Show the command output before saying done\.\ntype: rule\nstatus: active\ncreated_at: \S+\n---\nWhy: a claim without output was wrong twice\.\n$/);
    const index = readFileSync(`${ctx.home}/mem/INDEX.md`, "utf8");
    expect(index).toContain("- [verify-before-claiming](verify-before-claiming.md) (rule): Show the command output before saying done.");
    expect([r.indexLines, r.warning]).toEqual([1, null]);
  });

  it("search_matches_every_term_case_insensitively", () => {
    const m = store();
    m.add("a", "Lock files live next to their data", "mkdir based", "fact");
    m.add("b", "Workers get their own worktree", "one branch each", "rule");
    expect(m.search(["worktree"]).map((e) => e.name)).toEqual(["b"]);
    expect(m.search(["LOCK", "mkdir"]).map((e) => e.name)).toEqual(["a"]);
    expect(m.search(["lock", "branch"])).toEqual([]);
    expect(m.search([], { type: "rule" }).map((e) => e.name)).toEqual(["b"]);
    expect(m.search([]).map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("retire_supersedes_keeps_the_file_and_drops_it_from_the_index", () => {
    const m = store();
    m.add("old-rule", "Poll every minute", "", "rule");
    m.add("new-rule", "Poll every five minutes", "", "rule");
    const e = m.retire("old-rule", "new-rule");
    expect(e).toMatchObject({ status: "retired", superseded_by: "new-rule" });
    const text = readFileSync(`${ctx.home}/mem/old-rule.md`, "utf8");
    expect(text).toContain("status: retired\n");
    expect(text).toContain("superseded_by: new-rule\n");
    expect(text).toMatch(/retired_at: \S+\n/);
    expect(readFileSync(`${ctx.home}/mem/INDEX.md`, "utf8")).not.toContain("old-rule");
    expect(m.search(["poll"]).map((x) => x.name)).toEqual(["new-rule"]);
    expect(m.search(["poll"], { all: true }).map((x) => x.name).sort()).toEqual(["new-rule", "old-rule"]);
    expect(() => m.retire("old-rule", "new-rule")).toThrow(/already retired/);
  });

  it("retire_needs_a_live_successor_or_a_reason", () => {
    const m = store();
    m.add("x", "one", "");
    m.add("y", "two", "");
    expect(() => m.retire("x")).toThrow(/needs --superseded-by/);
    expect(() => m.retire("x", "missing")).toThrow(/add the replacement first/);
    expect(() => m.retire("x", "x")).toThrow(/supersede itself/);
    expect(() => m.retire("nope", "y")).toThrow(/no entry nope/);
    m.retire("y", null, "no longer true");
    expect(() => m.retire("x", "y")).toThrow(/itself retired/);
    expect(readFileSync(`${ctx.home}/mem/y.md`, "utf8")).toContain("retired_reason: no longer true\n");
  });

  it("the_index_cap_warns_but_still_writes", () => {
    const m = store(2);
    expect(m.add("n1", "one", "").warning).toBeNull();
    const r = m.add("n2", "two", "");
    expect(r.warning).toMatch(/index at cap: 2\/2 lines/);
    const r3 = m.add("n3", "three", "");
    expect(r3.warning).toMatch(/3\/2/);
    expect(existsSync(`${ctx.home}/mem/n3.md`)).toBe(true);
    m.retire("n1", "n3");
    expect(m.indexLines()).toBe(2);
  });

  it("names_descriptions_and_types_cannot_inject_frontmatter_or_paths", () => {
    const m = store();
    expect(() => m.add("../x", "d", "")).toThrow(MemError);
    expect(() => m.add("INDEX", "d", "")).toThrow(MemError);
    expect(() => m.add("ok", "line\nstatus: retired", "")).toThrow(/one line/);
    expect(() => m.add("ok", "  ", "")).toThrow(/empty/);
    expect(() => m.add("ok", "d", "", "two words")).toThrow(/bad type/);
    m.add("ok", "d", "---\nname: forged\n---\nstill body");
    const e = m.get("ok")!;
    expect(e.name).toBe("ok");
    expect(e.body).toBe("---\nname: forged\n---\nstill body");
    expect(() => m.add("ok", "again", "")).toThrow(/exists/);
  });

  it("files_that_are_not_entries_are_ignored", () => {
    const m = store();
    m.add("real", "d", "");
    writeFileSync(`${ctx.home}/mem/notes.md`, "no frontmatter here");
    writeFileSync(`${ctx.home}/mem/mismatch.md`, "---\nname: other\ndescription: x\n---\n");
    expect(m.all().map((e) => e.name)).toEqual(["real"]);
    expect(parseEntry("---\nname: a\n---\n", "f")).toBeNull(); // description is required
  });
});

describe("MemCliV2", () => {
  const ctx = useTmpHome();

  it("add_search_retire_through_the_cli", async () => {
    await run("init", "--no-handbook");
    let [code, out, err] = await run("mem", "add", "first", "-d", "The first note", "-t", "lesson", "-m", "body text");
    expect(code, err).toBe(0);
    expect(out).toContain("added first (lesson)");
    [code, out] = await runStdin("piped body\n", "mem", "add", "second", "--description", "The second note");
    expect(code).toBe(0);
    expect(readFileSync(`${ctx.home}/mem/second.md`, "utf8")).toContain("piped body");
    expect((await run("mem", "add", "third"))[0]).toBe(2); // --description is required
    [code, out] = await run("mem", "search", "note");
    expect(code).toBe(0);
    expect(out).toMatch(/first\s+lesson\s+The first note/);
    expect((await run("mem", "search", "zzz"))[0]).toBe(1);
    [code, out] = await run("mem", "retire", "first", "--superseded-by", "second");
    expect(out).toContain("retired first (superseded by second); file kept:");
    [code, out] = await run("mem", "search", "--all", "first", "--json");
    expect(JSON.parse(out)[0]).toMatchObject({ name: "first", status: "retired", superseded_by: "second" });
    expect((await run("mem", "retire", "second"))[0]).toBe(2);
  });

  it("cli_warns_on_stderr_at_the_cap", async () => {
    await run("init", "--no-handbook");
    writeFileSync(`${ctx.home}/config.toml`, readFileSync(`${ctx.home}/config.toml`, "utf8").replace("index_max_lines = 200", "index_max_lines = 1"));
    const [code, , err] = await run("mem", "add", "only", "-d", "one");
    expect(code).toBe(0);
    expect(err).toContain("mem: warning: index at cap: 1/1 lines");
  });
});
