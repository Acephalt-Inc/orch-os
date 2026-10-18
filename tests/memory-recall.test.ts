import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, hash, type Fact } from "../src/memory/schema.js";
import { display } from "../src/memory/display.js";
import { runMemoryCommand, type MemoryDeps } from "../src/memory/command.js";

const root = resolve(process.env.HOME!, "memory-recall-fixtures");
const binary = resolve("dist/cli.js");
const instant = Date.parse("2026-10-15T12:00:00.000Z");
type Result = { status: number | null; stdout: string; stderr: string };
type Place = { home: string; workspace: string; root: string; clock: string };

function place(): Place {
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "case-"));
  const home = join(folder, "home");
  const workspace = join(folder, "work");
  mkdirSync(home);
  mkdirSync(workspace);
  const clock = join(folder, "clock.cjs");
  writeFileSync(clock, "const NativeDate=Date;const fixed=Number(process.env.RECALL_TEST_TIME);" +
    "globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[fixed]))}static now(){return fixed}};\n");
  return { home, workspace, root: folder, clock };
}
function run(p: Place, args: string[], input?: string, at = instant): Result {
  const result = spawnSync(process.execPath, ["--require", p.clock, binary, "memory", ...args], {
    cwd: p.workspace, input, encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: p.home, RECALL_TEST_TIME: String(at) },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function sample(title: string, assertion = title, quote = assertion, suffix = ""): unknown {
  const text = quote + suffix;
  return { title, assertion, polarity: "affirmed", source: {
    text, fragmentStart: 0, fragmentEnd: Buffer.byteLength(quote), quote,
  } };
}
function saved(p: Place): { generation: number; committedAt: string; payload: { facts: Fact[]; lastObservedAt: string } } {
  const parent = join(p.home, ".orch-private", "memory-v1", "personal");
  return JSON.parse(readFileSync(join(parent, readdirSync(parent)[0], "state.json"), "utf8"));
}
function add(p: Place, value: unknown, generation = 0, at = instant): Fact {
  const result = run(p, ["add", "--expected-generation", String(generation)], JSON.stringify(value), at);
  expect(result).toEqual({ status: 0, stdout: expect.stringMatching(/^memory add: WRITTEN id=/), stderr: "" });
  const id = /^memory add: WRITTEN id=([0-9a-f-]+)/.exec(result.stdout)![1];
  return saved(p).payload.facts.find((fact) => fact.id === id)!;
}
function hit(f: Fact, score: number, generation: number, at = instant, omitted = 0): string {
  const source = f.sources[0];
  return canonical({ generation, items: [{ assertion: display(f.assertion), citation: {
    checkedAt: new Date(at).toISOString(), digest: f.digest,
    fragment: { end: source.fragmentEnd, start: source.fragmentStart }, generation, id: f.id,
    revision: f.revision, scopeId: hash(canonical(f.scope)), sourceHash: source.sha256,
    sourceId: source.sourceId, sourceRevision: 1,
  }, expiresAt: f.time.expiresAt, id: f.id, polarity: f.polarity, quote: display(source.quote),
    quoteTruncated: false, revision: f.revision, score, state: "active", title: display(f.title) }],
  omitted, partial: omitted > 0 }) + "\n";
}
const empty = (generation: number): Result => ({ status: 0, stdout: canonical({ generation, items: [], omitted: 0, partial: false }) + "\n", stderr: "" });
const refused = (code: string): Result => ({ status: 1, stdout: "", stderr: `memory recall: REFUSED ${code}\n` });
const recalled = (stdout: string): Result => ({ status: 0, stdout, stderr: "" });
const usage = (): Result => ({ status: 2, stdout: "", stderr: "memory recall: USAGE\n" });
function statePath(p: Place): string {
  const parent = join(p.home, ".orch-private", "memory-v1", "personal");
  return join(parent, readdirSync(parent)[0], "state.json");
}
async function direct(p: Place, args: string[], deps: MemoryDeps): Promise<Result> {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = p.home;
  process.chdir(p.workspace);
  let stdout = "";
  let stderr = "";
  try {
    const status = await runMemoryCommand(args, { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } }, deps);
    return { status, stdout, stderr };
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

describe.skipIf(process.platform === "win32")("installed memory recall", () => {
  it("recall_english_casefold_exact", () => {
    const p = place();
    const f = add(p, sample("alpha"));
    expect(run(p, ["recall", "--query", "ALPHA"])).toEqual(recalled(hit(f, 1.150728289807, 1)));
  });
  it("recall_expired_excluded_before_statistics", () => {
    const p = place();
    const old = instant - 91 * 86_400_000;
    add(p, sample("zeta", "zeta", "zeta"), 0, old);
    const f = add(p, sample("alpha", "alpha", "alpha", " current"), 1);
    expect(run(p, ["recall", "--query", "zeta"])).toEqual(empty(2));
    expect(run(p, ["recall", "--query", "alpha"])).toEqual(recalled(hit(f, 1.150728289807, 2)));
  });
  it("recall_single_han_exact", () => {
    const p = place();
    const f = add(p, sample("中文"));
    expect(run(p, ["recall", "--query", "中"])).toEqual(recalled(hit(f, 1.150728289807, 1)));
  });
  it("recall_mixed_han_latin_exact", () => {
    const p = place();
    const f = add(p, sample("中文件 alpha"));
    expect(run(p, ["recall", "--query", "文件 alpha"])).toEqual(recalled(hit(f, 2.401456579614, 1)));
  });
  it("recall_no_term_queries_refused", () => {
    const p = place();
    add(p, sample("alpha"));
    for (const query of ["", "  \u3000  ", "!!!…"]) expect(run(p, ["recall", "--query", query])).toEqual(refused("INVALID"));
  });
  it("recall_forgotten_fact_absent", () => {
    const p = place();
    const f = add(p, sample("alpha"));
    expect(run(p, ["forget", "--id", f.id, "--expected-revision", "1", "--expected-generation", "1"]).status).toBe(0);
    expect(run(p, ["recall", "--query", "alpha"])).toEqual(empty(2));
  });
  it("recall_source_quote_not_searchable", () => {
    const p = place();
    add(p, sample("alpha", "alpha", "needle"));
    expect(run(p, ["recall", "--query", "needle"])).toEqual(empty(1));
  });
  it("recall_query_controls_and_bidi_refused", () => {
    const p = place();
    add(p, sample("alpha"));
    const before = readFileSync(statePath(p));
    for (const query of ["a\u001bb", "a\u061cb", "a\u202eb"]) {
      expect(run(p, ["recall", "--query", query])).toEqual(refused("INVALID"));
    }
    expect(readFileSync(statePath(p))).toEqual(before);
  });
  it("recall_query_byte_and_term_caps", () => {
    const p = place();
    add(p, sample("alpha"));
    expect(run(p, ["recall", "--query", "a".repeat(2048)])).toEqual(empty(1));
    expect(run(p, ["recall", "--query", "a".repeat(2049)])).toEqual(refused("LIMIT"));
    expect(run(p, ["recall", "--query", Array.from({ length: 65 }, (_, i) => `a${i}`).join(" ")])).toEqual(refused("LIMIT"));
  });
  it("recall_duplicate_unknown_and_bad_flags", () => {
    const p = place();
    add(p, sample("alpha"));
    for (const args of [
      ["--query", "alpha", "--query", "beta"], ["--query", "alpha", "--limit", "2", "--limit", "3"],
      ["--query", "alpha", "--scope", "company"], ["--query", "alpha", "--unknown"],
      ["--query", "alpha", "--limit", "0"], ["--query", "alpha", "--limit", "01"],
      ["--query", "alpha", "--limit", "21"], ["--query", "alpha", "--limit", "1", "--all-terms"],
    ]) expect(run(p, ["recall", ...args])).toEqual(usage());
  });
  it("recall_lock_and_deadline_fixed_refusals", async () => {
    const p = place();
    add(p, sample("alpha"));
    mkdirSync(join(statePath(p), "..", ".lock"), { mode: 0o700 });
    expect(run(p, ["recall", "--query", "alpha"])).toEqual(refused("LOCK_HELD"));
    const q = place();
    add(q, sample("alpha"));
    expect(await direct(q, ["recall", "--query", "alpha"], {
      now: () => instant, seam: { clock: () => performance.now() + 100_000 },
    })).toEqual(refused("DEADLINE"));
  });
  it("recall_observed_rollback_refused", async () => {
    const p = place();
    add(p, sample("alpha"));
    const before = readFileSync(statePath(p));
    expect(await direct(p, ["recall", "--query", "alpha"], { now: () => instant - 1 })).toEqual(refused("INVALID"));
    expect(readFileSync(statePath(p))).toEqual(before);
  });
  it("recall_read_keeps_canonical_generation", () => {
    const p = place();
    const f = add(p, sample("alpha"));
    const before = readFileSync(statePath(p));
    const inode = statSync(statePath(p)).ino;
    const generation = saved(p).generation;
    const inventory = readdirSync(join(statePath(p), ".."));
    for (let i = 0; i < 2; i++) expect(run(p, ["recall", "--query", "alpha"])).toEqual(recalled(hit(f, 1.150728289807, 1)));
    expect(readFileSync(statePath(p))).toEqual(before);
    expect(statSync(statePath(p)).ino).toBe(inode);
    expect(saved(p).generation).toBe(generation);
    expect(readdirSync(join(statePath(p), ".."))).toEqual(inventory);
  });
  it("recall_limit_omissions_and_byte_overflow", () => {
    const p = place();
    const facts: Fact[] = [];
    for (let i = 0; i < 10; i++) facts.push(add(p, sample("alpha", "alpha", "alpha", ` source ${i}`), i));
    const first = facts.toSorted((a, b) => a.id < b.id ? -1 : 1)[0];
    expect(run(p, ["recall", "--query", "alpha", "--limit", "1"]))
      .toEqual(recalled(hit(first, 0.18608006254, 10, instant, 9)));
    const q = place();
    add(q, sample("alpha" + "😀".repeat(60), "😀".repeat(1024), "😀".repeat(256)));
    expect(run(q, ["recall", "--query", "alpha"])).toEqual(refused("LIMIT"));
  });
  it("recall_non_bmp_han_property", () => {
    const p = place();
    const f = add(p, sample("a𠀀b"));
    expect(run(p, ["recall", "--query", "𠀀"])).toEqual(recalled(hit(f, 1.150728289807, 1)));
  });
  it("recall_all_terms_intersection", () => {
    const p = place();
    add(p, sample("alpha"));
    expect(run(p, ["recall", "--query", "alpha beta", "--all-terms"])).toEqual(empty(1));
    expect(run(p, ["recall", "--query", "alpha beta"]).status).toBe(0);
    expect(JSON.parse(run(p, ["recall", "--query", "alpha beta"]).stdout).items).toHaveLength(1);
  });
  it("recall_repeated_query_term_counts_once", () => {
    const p = place();
    const f = add(p, sample("alpha"));
    expect(run(p, ["recall", "--query", "alpha alpha"]))
      .toEqual(recalled(hit(f, 1.150728289807, 1)));
  });
  it("recall_score_ties_use_ascii_id", () => {
    const p = place();
    const facts = [add(p, sample("alpha", "alpha", "alpha", " one"))];
    facts.push(add(p, sample("alpha", "alpha", "alpha", " two"), 1));
    const result = run(p, ["recall", "--query", "alpha"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).items.map((item: { id: string }) => item.id))
      .toEqual(facts.map((fact) => fact.id).sort());
  });
  it("recall_quote_excerpt_boundary_and_citation", () => {
    const p = place();
    const quote = "界".repeat(342);
    const f = add(p, sample("alpha", "alpha", quote));
    const result = run(p, ["recall", "--query", "alpha"]);
    const expected = JSON.parse(hit(f, 1.150728289807, 1));
    expected.items[0].quote = display("界".repeat(341));
    expected.items[0].quoteTruncated = true;
    expected.items[0].citation.fragment.end = 1023;
    expect(result).toEqual(recalled(canonical(expected) + "\n"));
  });
  it("recall_normalization_boundaries_and_field_frequency", () => {
    const p = place();
    add(p, sample("ＦＯＯ v2 café", "foo foo v2 café"));
    const matched = run(p, ["recall", "--query", "foo v2 cafe\u0301", "--all-terms"]);
    expect(matched.status).toBe(0);
    expect(JSON.parse(matched.stdout).items).toHaveLength(1);
    expect(run(p, ["recall", "--query", "foo\u200cv2", "--all-terms"]).status).toBe(0);
    expect(run(p, ["recall", "--query", "foo.2", "--all-terms"])).toEqual(empty(1));
    expect(run(p, ["recall", "--query", "v2", "--all-terms"]).status).toBe(0);
  });
  it("recall_corrupt_and_residual_temp_refuse_content", () => {
    const p = place();
    add(p, sample("alpha"));
    writeFileSync(join(statePath(p), "..", ".state-12345678-1234-4234-8234-123456789abc.tmp"), "", { mode: 0o600 });
    expect(run(p, ["recall", "--query", "alpha"])).toEqual(refused("UNAVAILABLE"));
    const q = place();
    add(q, sample("alpha"));
    writeFileSync(statePath(q), "{}\n", { mode: 0o600 });
    expect(run(q, ["recall", "--query", "alpha"])).toEqual(refused("UNAVAILABLE"));
  });
});
