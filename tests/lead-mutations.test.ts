// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Mutation witnesses for `orch lead`. Each entry of tests/fixtures/lead-claims.json changes the
// source in a way that makes one promise false, names one test of the real CLI and the bracketed
// labels of the assertions that must then fail.
//
// The change is applied to a disposable copy of this repository (never to the checkout), the
// changed file is compiled there, and the named test runs there in a child process with a kill
// deadline. A change counts as KILLED only when the named test ran and an assertion carrying
// each named label failed. A test that passes is SURVIVED. Anything else (the copy does not
// compile, the test is missing, the run times out, the test fails somewhere else) is INVALID and
// fails here: it is never counted as a kill. The controls near the end prove that rule.
//
// Around the changes: before the first one, every named test passes in the unchanged copy (clean
// control). After the last one, the copy is compared byte for byte with what it was before the
// first change, sources and compiled files, and every named test passes in it again (restored
// control): a change that was not put back would show there, not as a kill of a later mutant.
//
// Measured on macOS. Skipped on Windows unless ORCH_LEAD_UNMEASURED=1.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, WINDOWS } from "./_helpers.js";

const RUN = !WINDOWS || process.env.ORCH_LEAD_UNMEASURED === "1";
const WITNESS = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "lead-claims.json"), "utf8"));
interface Edit { file: string; find: string; replace: string }
interface Mutant { id: string; why?: string; test_file: string; test: string; markers: string[]; edits: Edit[]; timeout_ms?: number }
const MUTANTS: Mutant[] = WITNESS.mutants;
const CONTROLS: Mutant[] = WITNESS.controls;
const CHILD_DEADLINE_MS = 50_000;
/** Optional: a file that receives one JSON line per run (id, verdict, failed assertions), for a review packet. */
const REPORT = process.env.ORCH_LEAD_MUTATION_REPORT;
const record = (id: string, result: { verdict: string; detail: string }) => {
  if (REPORT) appendFileSync(REPORT, `${JSON.stringify({ id, ...result })}\n`);
};

let copy = "";
let counter = 0;
/** Every file of the copy that a change or a compile can touch, with its content hash, as it was before the first change. */
let unchanged: string[] = [];
function snapshot(): string[] {
  const walk = (rel: string): string[] => readdirSync(join(copy, ...rel.split("/")), { withFileTypes: true }).flatMap((entry) => {
    const r = `${rel}/${entry.name}`;
    return entry.isDirectory() ? walk(r) : [`${r} ${createHash("sha256").update(readFileSync(join(copy, ...r.split("/")))).digest("hex")}`];
  });
  return ["src", "dist", "templates", "docs", "tests"].flatMap(walk).sort();
}
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, newLine: ts.NewLineKind.LineFeed };

/** Compile one source file of the copy to its place under dist/, the way the build names it. */
function compile(rel: string): void {
  const out = join(copy, "dist", ...rel.split("/").slice(1)).replace(/\.ts$/, ".js");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, ts.transpileModule(readFileSync(join(copy, ...rel.split("/")), "utf8"), { compilerOptions: options, fileName: rel }).outputText);
}
function sourceFiles(dir: string): string[] {
  return readdirSync(join(copy, ...dir.split("/")), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${dir}/${entry.name}`] : []);
}

type Verdict = "KILLED" | "SURVIVED" | "INVALID";
/** Run one named test in the copy and say what happened. */
function runTest(testFile: string, test: string, markers: string[], timeoutMs = CHILD_DEADLINE_MS): { verdict: Verdict; detail: string } {
  const report = join(copy, `.result-${++counter}.json`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITEST|VITE_|TEST$|NODE_OPTIONS$)/.test(key)));
  const child = spawnSync(process.execPath, [join(copy, "node_modules", "vitest", "vitest.mjs"), "run", testFile, "-t", test, "--reporter=json", `--outputFile=${report}`],
    { cwd: copy, env, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  if (child.error || child.signal) return { verdict: "INVALID", detail: `the run did not finish: ${child.error?.message ?? child.signal}` };
  if (!existsSync(report)) return { verdict: "INVALID", detail: `no result was written\n${child.stdout}\n${child.stderr}`.slice(0, 2000) };
  const results = JSON.parse(readFileSync(report, "utf8")).testResults as { message?: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
  const ran = results.flatMap((file) => file.assertionResults).filter((a) => a.title === test && a.status !== "skipped" && a.status !== "pending");
  if (ran.length !== 1) return { verdict: "INVALID", detail: `the named test did not run (${ran.length} results) ${results.map((file) => file.message ?? "").join(" ")}`.slice(0, 2000) };
  if (ran[0].status === "passed") return { verdict: "SURVIVED", detail: "the named test passed" };
  const failed = ran[0].failureMessages.map((message) => /^AssertionError: \[([\w-]+)\]/.exec(message)?.[1] ?? "");
  const firstLines = ran[0].failureMessages.map((message) => message.split("\n")[0].slice(0, 200)).join("\n");
  if (markers.every((marker) => failed.includes(marker))) return { verdict: "KILLED", detail: firstLines };
  return { verdict: "INVALID", detail: `the test failed, but not at [${markers.join("], [")}]:\n${firstLines}` };
}
/** Apply the edits, run, and always put the copy back. */
function withEdits(mutant: Mutant): { verdict: Verdict; detail: string } {
  const originals = new Map<string, string>();
  try {
    for (const edit of mutant.edits) {
      const path = join(copy, ...edit.file.split("/"));
      const text = readFileSync(path, "utf8");
      if (!originals.has(edit.file)) originals.set(edit.file, text);
      if (text.split(edit.find).length !== 2) return { verdict: "INVALID", detail: `the text to change occurs ${text.split(edit.find).length - 1} times in ${edit.file}: ${edit.find}` };
      writeFileSync(path, text.replace(edit.find, () => edit.replace));
    }
    for (const file of originals.keys()) if (file.startsWith("src/")) compile(file);
    return runTest(mutant.test_file, mutant.test, mutant.markers, mutant.timeout_ms);
  } finally {
    for (const [file, text] of originals) {
      writeFileSync(join(copy, ...file.split("/")), text);
      if (file.startsWith("src/")) compile(file);
    }
  }
}

describe.skipIf(!RUN)("orch lead: mutation witnesses", () => {
  beforeAll(() => {
    copy = realpathSync.native(mkdtempSync(join(tmpdir(), "orch-lead-m-")));
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const assets: string[] = pkg.files.filter((p: string) => p !== "dist/");
    for (const path of ["src", "tests", "docs", "package.json", "tsconfig.json", "vitest.config.ts", ...assets]) cpSync(join(ROOT, path), join(copy, path), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), WINDOWS ? "junction" : "dir");
    for (const file of sourceFiles("src")) compile(file);
    unchanged = snapshot();
  });
  afterAll(() => {
    if (copy) rmSync(copy, { recursive: true, force: true });
  });

  // The unchanged copy passes every test a mutant names: a failure below is caused by the change.
  const named = [...new Set(MUTANTS.map((m) => `${m.test_file} ${m.test}`))];
  it.each(named)("clean control: %s passes in the unchanged copy", (pair) => {
    const [testFile, test] = pair.split(" ");
    const result = runTest(testFile, test, ["no-such-label"]);
    record(`clean control: ${test}`, result);
    expect(result, `the unchanged copy: ${result.detail}`).toMatchObject({ verdict: "SURVIVED" });
  });

  it.each(MUTANTS.map((m) => [m.id, m.markers.join(", "), m.test, m] as const))("mutant %s fails [%s] in %s", (_id, _markers, _test, mutant) => {
    const result = withEdits(mutant);
    record(mutant.id, result);
    expect(result, result.detail).toMatchObject({ verdict: "KILLED" });
  });

  it.each(CONTROLS.map((c) => [c.id, c.why, c] as const))("%s is INVALID, not a kill: %s", (_id, _why, control) => {
    const result = withEdits(control);
    record(control.id, result);
    expect(result, result.detail).toMatchObject({ verdict: "INVALID" });
  });

  // Every change was put back: the same bytes, and the same passing tests, as before the first one.
  it("restored control: sources and compiled files of the copy are byte for byte what they were before the first change", () => {
    const now = snapshot();
    record("restored control: bytes", { verdict: now.join("\n") === unchanged.join("\n") ? "SAME" : "DIFFERENT", detail: `${now.length} files` });
    expect(unchanged.length, "the copy was recorded before the first change").toBeGreaterThan(100);
    expect(now.filter((line) => !unchanged.includes(line)), "files that differ from the unchanged copy").toEqual([]);
    expect(now.length, "no file was added or lost").toBe(unchanged.length);
  });
  it.each(named)("restored control: %s passes again after every change was put back", (pair) => {
    const [testFile, test] = pair.split(" ");
    const result = runTest(testFile, test, ["no-such-label"]);
    record(`restored control: ${test}`, result);
    expect(result, `the restored copy: ${result.detail}`).toMatchObject({ verdict: "SURVIVED" });
  });
});
