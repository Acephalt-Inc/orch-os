import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runMemoryCommand, type MemoryDeps } from "../src/memory/command.js";
import { canonical } from "../src/memory/schema.js";

const scratch = resolve(process.env.HOME!, "memory-cli-fixtures");
const binary = resolve("dist/cli.js");
const observer = resolve("tests/fixtures/memory/observer.cjs");
const sample = {
  title: "Blue sky",
  assertion: "The sky is blue.",
  polarity: "affirmed",
  source: { text: "Today the sky is blue.", fragmentStart: 6, fragmentEnd: 21, quote: "the sky is blue" },
};
type Result = { status: number | null; stdout: string; stderr: string };

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-"));
  const home = join(root, "home");
  const workspace = join(root, "work");
  mkdirSync(home);
  mkdirSync(workspace);
  return { home, workspace };
}

function run(place: ReturnType<typeof fixture>, args: string[], input?: string | Buffer): Result {
  const result = spawnSync(process.execPath, [binary, "memory", ...args], {
    cwd: place.workspace,
    env: { ...process.env, HOME: place.home },
    input,
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(place: ReturnType<typeof fixture>, args: string[], input?: string): Promise<Result> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [binary, "memory", ...args], {
      cwd: place.workspace,
      env: { ...process.env, HOME: place.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function direct(place: ReturnType<typeof fixture>, args: string[], deps: MemoryDeps, input = ""): Promise<Result> {
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  process.env.HOME = place.home;
  process.chdir(place.workspace);
  let stdout = "";
  let stderr = "";
  try {
    const status = await runMemoryCommand(args, {
      out: (text) => { stdout += text; },
      err: (text) => { stderr += text; },
      stdinBytes: () => Buffer.from(input),
    }, deps);
    return { status, stdout, stderr };
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  }
}

function add(place: ReturnType<typeof fixture>, value: unknown = sample, generation = 0): Result {
  return run(place, ["add", "--expected-generation", String(generation)], JSON.stringify(value));
}

function state(place: ReturnType<typeof fixture>): { generation: number; payload: any } {
  const directory = join(place.home, ".orch-private", "memory-v1", "personal");
  const partition = readdirSync(directory)[0];
  return JSON.parse(readFileSync(join(directory, partition, "state.json"), "utf8"));
}

function accepted(place: ReturnType<typeof fixture>) {
  const receipt = add(place);
  expect(receipt.stderr).toBe("");
  expect(receipt.status).toBe(0);
  const saved = state(place);
  const fact = saved.payload.facts[0];
  expect(receipt.stdout).toBe(`memory add: WRITTEN id=${fact.id} revision=1 generation=1\n`);
  return fact;
}

function refused(result: Result, verb: string, code: string) {
  expect(result).toEqual({ status: 1, stdout: "", stderr: `memory ${verb}: REFUSED ${code}\n` });
}

describe.skipIf(process.platform === "win32")("installed memory command", () => {
  it("input_does_not_select_storage_process_or_network_effects", () => {
    const place = fixture();
    const value = { ...sample, assertion: "fetch https://example.invalid/", source: {
      text: "fetch https://example.invalid/", fragmentStart: 0, fragmentEnd: 5, quote: "fetch",
    } };
    const result = spawnSync(process.execPath, ["--require", observer, binary, "memory", "add", "--expected-generation", "0"], {
      cwd: place.workspace,
      env: { ...process.env, HOME: place.home },
      input: JSON.stringify(value),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    const fact = state(place).payload.facts[0];
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0, stdout: `memory add: WRITTEN id=${fact.id} revision=1 generation=1\n`, stderr: "",
    });
    const trace = JSON.parse(result.output[3] as string) as { writes: { name: string; path: string }[] };
    expect(trace.writes.length).toBeGreaterThan(0);
    const root = join(place.home, ".orch-private");
    expect(trace.writes.every((entry) => entry.path === root || entry.path.startsWith(root + "/"))).toBe(true);
  });
  it("unknown verb has fixed usage", () => {
    const place = fixture();
    expect(run(place, ["unknown"])).toEqual({ status: 2, stdout: "", stderr: "memory: USAGE\n" });
  });
  it("add_restart_show_exact", () => {
    const place = fixture();
    const fact = accepted(place);
    const source = fact.sources[0];
    const saved = state(place);
    const root = join(place.home, ".orch-private", "memory-v1", "personal");
    const raw = readFileSync(join(root, readdirSync(root)[0], "state.json"), "utf8");
    expect(raw).toBe(canonical(saved) + "\n");
    const expected = {
      assertion: sample.assertion,
      digest: fact.digest,
      expiresAt: fact.time.expiresAt,
      generation: 1,
      id: fact.id,
      polarity: sample.polarity,
      revision: 1,
      source: {
        fragmentEnd: 21,
        fragmentStart: 6,
        quote: "the sky is blue",
        sha256: createHash("sha256").update(sample.source.text).digest("hex"),
        sourceId: source.sourceId,
      },
      title: sample.title,
    };
    expect(run(place, ["show", "--id", fact.id])).toEqual({ status: 0, stdout: JSON.stringify(expected) + "\n", stderr: "" });
  });

  it("forget_removes_fact_and_source", () => {
    const place = fixture();
    const fact = accepted(place);
    const result = run(place, ["forget", "--id", fact.id, "--expected-revision", "1", "--expected-generation", "1"]);
    expect(result).toEqual({ status: 0, stdout: `memory forget: DONE id=${fact.id} generation=2\n`, stderr: "" });
    refused(run(place, ["show", "--id", fact.id]), "show", "DELETED");
    expect(run(place, ["list"])).toEqual({ status: 0, stdout: '{"generation":2,"items":[],"nextAfter":null}\n', stderr: "" });
    const saved = state(place);
    expect(saved.payload.facts).toEqual([]);
    expect(saved.payload.tombstones).toEqual([{ schemaVersion: 1, id: fact.id, deletedAt: expect.any(String), sequence: 2 }]);
    expect(JSON.stringify(saved)).not.toContain(sample.source.text);
    const root = join(place.home, ".orch-private", "memory-v1", "personal");
    expect(readdirSync(join(root, readdirSync(root)[0]))).toEqual(["state.json"]);
  });

  it("forget_unknown_id_refused", () => {
    const place = fixture();
    accepted(place);
    const before = JSON.stringify(state(place));
    refused(run(place, ["forget", "--id", randomUUID(), "--expected-revision", "1", "--expected-generation", "1"]), "forget", "NOT_FOUND");
    expect(JSON.stringify(state(place))).toBe(before);
  });

  it("forget_missing_partition_is_not_found", () => {
    const place = fixture();
    refused(run(place, ["forget", "--id", randomUUID(), "--expected-revision", "1", "--expected-generation", "0"]),
      "forget", "NOT_FOUND");
  });

  it("duplicate_add_refused", () => {
    const place = fixture();
    accepted(place);
    refused(add(place, { ...sample, title: "Second" }, 1), "add", "INVALID");
    expect(state(place).generation).toBe(1);
    expect(state(place).payload.facts).toHaveLength(1);
  });

  it("stale_revision_and_generation_refused", () => {
    const place = fixture();
    const fact = accepted(place);
    refused(run(place, ["forget", "--id", fact.id, "--expected-revision", "0", "--expected-generation", "1"]), "forget", "INVALID");
    refused(run(place, ["forget", "--id", fact.id, "--expected-revision", "1", "--expected-generation", "0"]), "forget", "CONFLICT");
    expect(state(place).payload.facts).toHaveLength(1);
  });

  it("traversal_and_unknown_scope_refused", () => {
    const place = fixture();
    expect(run(place, ["show", "--id", "../other"])).toEqual({ status: 2, stdout: "", stderr: "memory show: USAGE\n" });
    expect(run(place, ["list", "--scope", "company"])).toEqual({ status: 2, stdout: "", stderr: "memory list: USAGE\n" });
    expect(run(place, ["show", "--workspace", "../other"])).toEqual({ status: 2, stdout: "", stderr: "memory show: USAGE\n" });
    refused(add(place, { ...sample, scope: "company" }), "add", "INVALID");
  });

  it("duplicate_json_key_refused", () => {
    const place = fixture();
    const input = '{"title":"x","\\u0074itle":"y","assertion":"a","polarity":"affirmed","source":{"text":"a","fragmentStart":0,"fragmentEnd":1,"quote":"a"}}';
    refused(run(place, ["add", "--expected-generation", "0"], input), "add", "INVALID");
  });

  it("invalid_utf8_refused", () => {
    const place = fixture();
    refused(run(place, ["add", "--expected-generation", "0"], Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d])), "add", "INVALID");
    refused(run(place, ["add", "--expected-generation", "0"], '{"title":"\\ud800"}'), "add", "INVALID");
  });

  it("oversize_fact_refused", () => {
    const place = fixture();
    refused(add(place, { ...sample, assertion: "x".repeat(4097) }), "add", "LIMIT");
    refused(run(place, ["add", "--expected-generation", "0"], " ".repeat(16385)), "add", "LIMIT");
    refused(add(place, {
      title: "x".repeat(256), assertion: "a".repeat(3700), polarity: "affirmed",
      source: { text: "x".repeat(8192), fragmentStart: 0, fragmentEnd: 4000, quote: "x".repeat(4000) },
    }), "add", "LIMIT");
  });

  it("missing_or_false_source_refused", () => {
    const place = fixture();
    refused(add(place, { title: "x", assertion: "y", polarity: "affirmed" }), "add", "INVALID");
    refused(add(place, { ...sample, source: { ...sample.source, quote: "" } }), "add", "INVALID");
    refused(add(place, { ...sample, source: { ...sample.source, quote: "not the span" } }), "add", "INVALID");
  });

  it("lock_held_and_deadline_fixed_refusals", async () => {
    const place = fixture();
    const fact = accepted(place);
    const root = join(place.home, ".orch-private", "memory-v1", "personal");
    const lock = join(root, readdirSync(root)[0], ".lock");
    mkdirSync(lock, { mode: 0o700 });
    refused(run(place, ["show", "--id", fact.id]), "show", "LOCK_HELD");
    const another = fixture();
    const second = accepted(another);
    refused(await direct(another, ["show", "--id", second.id], {
      seam: { clock: () => performance.now() + 100_000 },
    }), "show", "DEADLINE");
  });

  it("concurrent_add_forget_one_generation", async () => {
    const place = fixture();
    const fact = accepted(place);
    const next = { ...sample, source: { text: "A different sentence.", fragmentStart: 0, fragmentEnd: 1, quote: "A" } };
    const [addResult, forgetResult] = await Promise.all([
      runAsync(place, ["add", "--expected-generation", "1"], JSON.stringify(next)),
      runAsync(place, ["forget", "--id", fact.id, "--expected-revision", "1", "--expected-generation", "1"]),
    ]);
    expect([addResult.status, forgetResult.status].sort()).toEqual([0, 1]);
    expect(state(place).generation).toBe(2);
    const saved = state(place).payload;
    const winner = addResult.status === 0 ? "add" : "forget";
    const loser = addResult.status === 1 ? addResult : forgetResult;
    expect(loser).toEqual({ status: 1, stdout: "", stderr: `memory ${winner === "add" ? "forget" : "add"}: REFUSED CONFLICT\n` });
    expect(saved.facts.length).toBe(winner === "add" ? 2 : 0);
    expect(saved.tombstones.length).toBe(winner === "add" ? 0 : 1);
  });

  it("observed_clock_rollback_refused", async () => {
    const place = fixture();
    const fact = accepted(place);
    const saved = state(place);
    saved.payload.lastObservedAt = "9999-01-01T00:00:00.000Z";
    const root = join(place.home, ".orch-private", "memory-v1", "personal");
    const path = join(root, readdirSync(root)[0], "state.json");
    writeFileSync(path, JSON.stringify(saved) + "\n", { mode: 0o600 });
    refused(run(place, ["show", "--id", fact.id]), "show", "INVALID");
    saved.payload.lastObservedAt = "1970-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(saved) + "\n", { mode: 0o600 });
    refused(await direct(place, ["show", "--id", fact.id], {
      now: () => Date.parse(saved.committedAt) - 1,
    }), "show", "INVALID");
  });

  it("observed_clock_rollback_refused_in_every_command", async () => {
    const place = fixture();
    const fact = accepted(place);
    const before = JSON.stringify(state(place));
    const earlier = Date.parse(fact.time.recordedAt) - 1;
    const clock = { now: () => earlier };
    refused(await direct(place, ["show", "--id", fact.id], clock), "show", "INVALID");
    refused(await direct(place, ["list"], clock), "list", "INVALID");
    refused(await direct(place, ["add", "--expected-generation", "1"], clock, JSON.stringify({
      ...sample, source: { text: "Different", fragmentStart: 0, fragmentEnd: 1, quote: "D" },
    })), "add", "INVALID");
    refused(await direct(place, ["forget", "--id", fact.id, "--expected-revision", "1", "--expected-generation", "1"],
      clock), "forget", "INVALID");
    expect(JSON.stringify(state(place))).toBe(before);
  });

  it("expired_fact_is_hidden", async () => {
    const place = fixture();
    const fact = accepted(place);
    const clock = { now: () => Date.parse(fact.time.expiresAt) };
    refused(await direct(place, ["show", "--id", fact.id], clock), "show", "STALE");
    expect(await direct(place, ["list"], clock)).toEqual({
      status: 0, stdout: '{"generation":1,"items":[],"nextAfter":null}\n', stderr: "",
    });
  });

  it("forget_unverified_receipt_not_done", async () => {
    const place = fixture();
    const fact = accepted(place);
    const result = await direct(place,
      ["forget", "--id", fact.id, "--expected-revision", "1", "--expected-generation", "1"], {
        seam: { sync: async (handle) => {
          if ((await handle.stat()).isDirectory()) throw new Error("test directory sync refusal");
          await handle.sync();
        } },
      });
    expect(result).toEqual({ status: 3, stdout: "", stderr: "memory forget: WRITTEN_UNVERIFIED\n" });
    expect(state(place).generation).toBe(2);
    expect(state(place).payload.facts).toEqual([]);
  });

  it("uncertain_rename_has_no_success_claim", async () => {
    const place = fixture();
    const result = await direct(place, ["add", "--expected-generation", "0"], {
      seam: { rename: async () => { throw Object.assign(new Error("test rename refusal"), { code: "EIO" }); } },
    }, JSON.stringify(sample));
    expect(result).toEqual({ status: 3, stdout: "", stderr: "memory add: OUTCOME_UNKNOWN\n" });
  });

  it("corrupt_snapshot_and_residual_temp_refuse_content", () => {
    const corruptPlace = fixture();
    const corruptFact = accepted(corruptPlace);
    const root = join(corruptPlace.home, ".orch-private", "memory-v1", "personal");
    const path = join(root, readdirSync(root)[0], "state.json");
    writeFileSync(path, "{}\n", { mode: 0o600 });
    refused(run(corruptPlace, ["show", "--id", corruptFact.id]), "show", "UNAVAILABLE");
    const tempPlace = fixture();
    const tempFact = accepted(tempPlace);
    const tempRoot = join(tempPlace.home, ".orch-private", "memory-v1", "personal");
    const temp = join(tempRoot, readdirSync(tempRoot)[0], `.state-${randomUUID()}.tmp`);
    writeFileSync(temp, "", { mode: 0o600 });
    refused(run(tempPlace, ["show", "--id", tempFact.id]), "show", "UNAVAILABLE");
  });

  it("terminal_controls_escaped", () => {
    const place = fixture();
    refused(add(place, { ...sample, title: "bad\u001btitle" }), "add", "INVALID");
    const value = { ...sample, assertion: "line\n\u001b\u0085\u202e", source: { text: "A\n\u001b\u0085\u202e", fragmentStart: 0, fragmentEnd: 1, quote: "A" } };
    const receipt = add(place, value);
    expect(receipt.status).toBe(0);
    expect(receipt.stdout).toMatch(/^memory add: WRITTEN id=[0-9a-f-]+ revision=1 generation=1\n$/);
    const fact = state(place).payload.facts[0];
    const shown = run(place, ["show", "--id", fact.id]);
    expect(shown.status).toBe(0);
    expect(shown).toEqual({ status: 0, stderr: "", stdout: JSON.stringify({
      assertion: "line\\u000a\\u001b\\u0085\\u202e", digest: fact.digest, expiresAt: fact.time.expiresAt,
      generation: 1, id: fact.id, polarity: "affirmed", revision: 1,
      source: { fragmentEnd: 1, fragmentStart: 0, quote: "A", sha256: fact.sources[0].sha256,
        sourceId: fact.sources[0].sourceId }, title: "Blue sky",
    }) + "\n" });
    expect(run(place, ["list"])).toEqual({ status: 0, stderr: "", stdout: JSON.stringify({
      generation: 1, items: [{ id: fact.id, revision: 1, title: "Blue sky" }], nextAfter: null,
    }) + "\n" });
  });
  it("title_bidi_controls_refused", () => {
    const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    const matched: number[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code < 0xd800 || code > 0xdfff) { if (/\p{Bidi_Control}/u.test(String.fromCodePoint(code))) matched.push(code); }
    }
    expect(matched).toEqual(bidi);
    const place = fixture();
    for (const code of bidi) refused(add(place, { ...sample, title: `a${String.fromCodePoint(code)}b` }), "add", "INVALID");
    expect(add(place).status).toBe(0);
    expect(state(place).generation).toBe(1);
    expect(state(place).payload.facts).toHaveLength(1);
  });
});
