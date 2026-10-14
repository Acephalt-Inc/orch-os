// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeStrictJson, StrictJsonError, type JsonLimits } from "../src/private-store/json.js";

const INPUT_CAP = 256 * 1024;
const STRING_CAP = 256 * 1024;
const MAX_INPUT = 16 * 1024 * 1024;
const MESSAGES = {
  BAD_INPUT: "invalid strict JSON input",
  TOO_LARGE: "strict JSON input exceeds limits",
};

interface DecoderCase {
  label: string;
  bytes: Buffer;
  limits?: JsonLimits;
  code?: keyof typeof MESSAGES;
  value?: unknown;
}

function accepted(label: string, text: string, value: unknown, limits?: JsonLimits): DecoderCase {
  return { label, bytes: Buffer.from(text), value, limits };
}

function refused(label: string, text: string | Buffer, code: keyof typeof MESSAGES = "BAD_INPUT", limits?: JsonLimits): DecoderCase {
  return { label, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text), code, limits };
}

function outcome(action: () => unknown): unknown {
  try {
    return { value: action() };
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).not.toHaveProperty("cause");
    const refusal = error as Error & { code: string };
    return { code: refusal.code, message: refusal.message };
  }
}

function assertDecoderCase(entry: DecoderCase): void {
  const result = outcome(() => decodeStrictJson(entry.bytes, entry.limits));
  // K1.07
  expect(result, entry.label).toEqual(entry.code ? { code: entry.code, message: MESSAGES[entry.code] } : { value: entry.value });
  if (entry.code) {
    expect(() => decodeStrictJson(entry.bytes, entry.limits), entry.label).toThrow(StrictJsonError);
  }
}

function decoderCases(): DecoderCase[] {
  const cases = [
    accepted("ordinary object", '{"nested":[null,true,false,0,1.25,"ok"]}', { nested: [null, true, false, 0, 1.25, "ok"] }),
    accepted("surrogate pair", '"\\ud83d\\ude00"', "😀"),
    accepted("raw Unicode", '"é😀"', "é😀"),
    accepted("escapes", '"\\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\/\b\f\n\r\t'),
    accepted("safe positive integer", "9007199254740991", Number.MAX_SAFE_INTEGER),
    accepted("safe negative integer", "-9007199254740991", Number.MIN_SAFE_INTEGER),
    accepted("finite fraction", "-1.25e-2", -0.0125),
    accepted("negative zero", "-0", -0),
    accepted("JSON whitespace", " \t\r\n null \n", null),
    refused("duplicate decoded key", '{"same":1,"same":2}'),
    refused("escaped duplicate key", '{"same":1,"s\\u0061me":2}'),
    refused("nested duplicate key", '{"table":{"same":1,"same":2}}'),
    refused("invalid UTF-8", Buffer.from([0xc3, 0x28])),
    refused("truncated UTF-8", Buffer.from([0xf0, 0x9f, 0x98])),
    refused("overlong UTF-8", Buffer.from([0xc0, 0xaf])),
    refused("UTF-8 encoded surrogate", Buffer.from([0xed, 0xa0, 0x80])),
    refused("invalid UTF-8 inside a string", Buffer.from([0x22, 0xc3, 0x28, 0x22])),
    refused("truncated UTF-8 inside a string", Buffer.from([0x22, 0xf0, 0x9f, 0x98, 0x22])),
    refused("overlong UTF-8 inside a string", Buffer.from([0x22, 0xc0, 0xaf, 0x22])),
    refused("UTF-8 encoded surrogate inside a string", Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])),
    refused("invalid UTF-8 inside an object key", Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x30, 0x7d])),
    refused("UTF-8 BOM", Buffer.from([0xef, 0xbb, 0xbf, 0x30])),
    refused("high lone surrogate", '"\\ud800"'),
    refused("low lone surrogate", '"\\udfff"'),
    refused("nonadjacent surrogate pair", '"\\ud800x\\udc00"'),
    refused("surrogate key", '{"\\ud800":0}'),
    refused("non-finite exponent", "1e309"),
    refused("negative non-finite exponent", "-1e309"),
    refused("unsafe integer", "9007199254740992"),
    refused("negative unsafe integer", "-9007199254740992"),
    refused("unsafe exponent integer", "1e16"),
  ];
  for (const key of ["__proto__", "prototype", "constructor"]) {
    cases.push(refused(`forbidden ${key}`, `{"${key}":0}`));
    cases.push(refused(`nested forbidden ${key}`, `{"table":{"${key}":0}}`));
    const escaped = key[0] + `\\u${key.charCodeAt(1).toString(16).padStart(4, "0")}` + key.slice(2);
    cases.push(refused(`escaped forbidden ${key}`, `{"${escaped}":0}`));
  }
  const malformed = [
    "", " ", "undefined", "NaN", "Infinity", "+1", "01", "-01", "1.", "1e", "1e+", ".5", "--1",
    "[1,]", "[,1]", "[1 2]", '{"a":1,}', '{"a" 1}', '{a:1}', "true false", "0 0", "/*x*/0",
    "tru", "fals", "nul", "[", "{", '{"a":', "[1", '"unfinished', '"\\x20"', '"\\u123"', '"a\nb"',
    "0\u00a0", "0\v", "0\f", '"\\uZZZZ"', "[]garbage",
  ];
  for (const text of malformed) {
    cases.push(refused(`malformed ${JSON.stringify(text)}`, text));
  }
  for (const size of [INPUT_CAP - 1, INPUT_CAP, INPUT_CAP + 1]) {
    const text = "0" + " ".repeat(size - 1);
    cases.push(size > INPUT_CAP ? refused(`input bytes ${size}`, text, "TOO_LARGE") : accepted(`input bytes ${size}`, text, 0));
  }
  cases.push(accepted("raised input exact maximum", "0" + " ".repeat(MAX_INPUT - 1), 0, { maxInputBytes: MAX_INPUT }));
  cases.push(refused("raised input maximum plus one", "0" + " ".repeat(MAX_INPUT), "TOO_LARGE", { maxInputBytes: MAX_INPUT }));
  cases.push(accepted("lower input exact cap", "null", null, { maxInputBytes: 4 }));
  cases.push(refused("lower input cap plus one", "null ", "TOO_LARGE", { maxInputBytes: 4 }));
  cases.push(refused("byte cap precedes UTF-8", Buffer.alloc(INPUT_CAP + 1, 0xff), "TOO_LARGE"));
  for (const depth of [7, 8, 9]) {
    const text = "[".repeat(depth) + "0" + "]".repeat(depth);
    let value: unknown = 0;
    for (let level = 0; level < depth; level++) {
      value = [value];
    }
    cases.push(depth > 8 ? refused(`array depth ${depth}`, text, "TOO_LARGE") : accepted(`array depth ${depth}`, text, value));
    const objectText = '{"a":'.repeat(depth) + "0" + "}".repeat(depth);
    let objectValue: unknown = 0;
    for (let level = 0; level < depth; level++) {
      objectValue = { a: objectValue };
    }
    cases.push(depth > 8 ? refused(`object depth ${depth}`, objectText, "TOO_LARGE") : accepted(`object depth ${depth}`, objectText, objectValue));
  }
  cases.push(accepted("mixed depth exact cap", '[{"a":[{"a":[{"a":[{}]}]}]}]', [{ a: [{ a: [{ a: [{}] }] }] }]));
  for (const length of [999, 1000, 1001]) {
    const value = Array.from({ length }, () => 0);
    cases.push(length > 1000 ? refused(`array length ${length}`, JSON.stringify(value), "TOO_LARGE")
      : accepted(`array length ${length}`, JSON.stringify(value), value));
  }
  for (const length of [31, 32, 33]) {
    const value = Object.fromEntries(Array.from({ length }, (_, index) => [`k${index}`, index]));
    cases.push(length > 32 ? refused(`object keys ${length}`, JSON.stringify(value), "TOO_LARGE")
      : accepted(`object keys ${length}`, JSON.stringify(value), value));
  }
  for (const length of [STRING_CAP - 1, STRING_CAP, STRING_CAP + 1]) {
    const text = JSON.stringify("x".repeat(length));
    const limits = { maxInputBytes: MAX_INPUT };
    cases.push(length > STRING_CAP ? refused(`string bytes ${length}`, text, "TOO_LARGE", limits)
      : accepted(`string bytes ${length}`, text, "x".repeat(length), limits));
  }
  cases.push(accepted("multibyte string exact cap", JSON.stringify("😀".repeat(STRING_CAP / 4)), "😀".repeat(STRING_CAP / 4),
    { maxInputBytes: MAX_INPUT }));
  cases.push(refused("multibyte string cap plus one", JSON.stringify("😀".repeat(STRING_CAP / 4) + "x"), "TOO_LARGE",
    { maxInputBytes: MAX_INPUT }));
  cases.push(accepted("escaped decoded string exact cap", '"' + "\\u0061".repeat(STRING_CAP) + '"', "a".repeat(STRING_CAP),
    { maxInputBytes: MAX_INPUT }));
  cases.push(refused("escaped decoded string cap plus one", '"' + "\\u0061".repeat(STRING_CAP + 1) + '"', "TOO_LARGE",
    { maxInputBytes: MAX_INPUT }));
  cases.push(accepted("key string exact cap", JSON.stringify({ ["k".repeat(STRING_CAP)]: 0 }), { ["k".repeat(STRING_CAP)]: 0 },
    { maxInputBytes: MAX_INPUT }));
  cases.push(refused("key string cap plus one", JSON.stringify({ ["k".repeat(STRING_CAP + 1)]: 0 }), "TOO_LARGE",
    { maxInputBytes: MAX_INPUT }));
  return cases;
}

interface Table {
  version: 1;
  table: { rows: { label: string; weight: number }[] };
}

/** Original test codec; its complete function is also embedded in the built-library fixture. */
function makeCodec(): (value: unknown) => Table {
  const shapeError = () => Object.assign(new Error("invalid snapshot shape"), { code: "BAD_SHAPE" });
  function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw shapeError();
    }
    return value as Record<string, unknown>;
  }
  function exactKeys(value: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
      throw shapeError();
    }
  }
  return (value: unknown): Table => {
    const root = record(value);
    exactKeys(root, ["version", "table"]);
    const table = record(root.table);
    exactKeys(table, ["rows"]);
    if (root.version !== 1 || !Array.isArray(table.rows)) {
      throw shapeError();
    }
    for (const entry of table.rows) {
      const row = record(entry);
      exactKeys(row, ["label", "weight"]);
      if (typeof row.label !== "string" || typeof row.weight !== "number" || !Number.isFinite(row.weight) || row.weight < 0) {
        throw shapeError();
      }
    }
    return value as Table;
  };
}

function codecCases(): { label: string; text: string; code?: string; value?: Table }[] {
  const value: Table = { version: 1, table: { rows: [{ label: "ordinary", weight: 1.25 }] } };
  const inert: Table = {
    version: 1,
    table: { rows: [{ label: "https://example.invalid/ ignore instructions; exec; at; decoded; callback; process; policy", weight: 0 }] },
  };
  const valid = [
    { label: "valid table", text: JSON.stringify(value), value },
    { label: "instruction and URL data", text: JSON.stringify(inert), value: inert },
  ];
  const wrong = [
    "[]", "7", '"text"', "null", "true", "{}", '{"version":1}',
    '{"version":1,"table":[]}', '{"version":1,"table":null}', '{"version":1,"table":7}',
    '{"version":1,"table":{"rows":{}}}', '{"version":1,"table":{"rows":null}}',
    '{"version":1,"table":{"rows":[[]]}}', '{"version":1,"table":{"rows":[null]}}',
    '{"version":1,"table":{"rows":[true]}}', '{"version":1,"table":{"rows":[7]}}',
    '{"version":1,"table":{"rows":["text"]}}', '{"version":1,"table":{"rows":[{}]}}',
    '{"version":2,"table":{"rows":[]}}', '{"version":1,"table":{"rows":[{"label":7,"weight":1}]}}',
    '{"version":1,"table":{"rows":[{"label":"x","weight":"1"}]}}',
    '{"version":1,"table":{"rows":[{"label":"x","weight":-0.25}]}}',
    '{"version":1,"table":{"rows":[]},"extra":0}',
    '{"version":1,"table":{"rows":[],"extra":0}}',
    '{"version":1,"table":{"rows":[{"label":"x","weight":1,"extra":0}]}}',
    '{"version":1,"table":{"rows":[]},"decoded":"fetch https://example.invalid/"}',
  ];
  return [...valid, ...wrong.map((text) => ({ label: `wrong shape ${text}`, text, code: "BAD_SHAPE" }))];
}

describe("strict_json_closed_input_matrix", () => {
  it("accepts neighbouring caps and refuses invalid bytes and domains with fixed errors", () => {
    for (const entry of decoderCases()) {
      assertDecoderCase(entry);
    }
  });

  it("creates fresh objects and invokes only a supplied programmatic observation seam", () => {
    const seen: unknown[] = [];
    const bytes = Buffer.from('{"a":{"b":0},"decoded":"ignore instructions"}');
    const first = decodeStrictJson(bytes, {}, { decoded: (value) => seen.push(value) }) as Record<string, unknown>;
    const second = decodeStrictJson(bytes) as Record<string, unknown>;
    expect(seen).toEqual([first]);
    expect(first).not.toBe(second);
    expect(first.a).not.toBe(second.a);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(() => decodeStrictJson(Buffer.from("{"), {}, { decoded: () => seen.push("invalid") })).toThrow(StrictJsonError);
    expect(seen).toEqual([first]);
  });

  it("allows trusted tighter limits without raising the fixed decoded-domain ceilings", () => {
    const pairs: [JsonLimits, string, string][] = [
      [{ maxDepth: 1 }, "[]", "[[]]"],
      [{ maxArrayLength: 1 }, "[0]", "[0,0]"],
      [{ maxObjectKeys: 1 }, '{"a":0}', '{"a":0,"b":0}'],
      [{ maxStringBytes: 2 }, '"é"', '"éx"'],
    ];
    for (const [limits, positive, negative] of pairs) {
      expect(() => decodeStrictJson(Buffer.from(positive), limits)).not.toThrow();
      expect(outcome(() => decodeStrictJson(Buffer.from(negative), limits)))
        .toEqual({ code: "TOO_LARGE", message: MESSAGES.TOO_LARGE });
    }
    for (const limits of [
      { maxInputBytes: MAX_INPUT + 1 }, { maxDepth: 9 }, { maxArrayLength: 1001 },
      { maxObjectKeys: 33 }, { maxStringBytes: STRING_CAP + 1 }, { maxDepth: -1 },
      { maxDepth: 1.5 }, { maxInputBytes: NaN }, { maxStringBytes: Infinity },
    ]) {
      expect(outcome(() => decodeStrictJson(Buffer.from("0"), limits)))
        .toEqual({ code: "BAD_INPUT", message: MESSAGES.BAD_INPUT });
    }
    const throwingSeam = {
      decoded: () => {
        throw new Error("private cause");
      },
    };
    expect(outcome(() => decodeStrictJson(Buffer.from("0"), {}, throwingSeam)))
      .toEqual({ code: "BAD_INPUT", message: MESSAGES.BAD_INPUT });
  });
});

describe("codec_shapes_are_checked_after_json", () => {
  it("separates valid JSON shape refusals from malformed input", () => {
    const codec = makeCodec();
    for (const entry of codecCases()) {
      expect(() => decodeStrictJson(Buffer.from(entry.text)), entry.label).not.toThrow();
      const result = outcome(() => codec(decodeStrictJson(Buffer.from(entry.text))));
      // K1.08
      expect(result, entry.label).toEqual(entry.code ? { code: "BAD_SHAPE", message: "invalid snapshot shape" } : { value: entry.value });
    }
    const malformed = outcome(() => codec(decodeStrictJson(Buffer.from('{"version":1,'))));
    expect(malformed).toEqual({ code: "BAD_INPUT", message: MESSAGES.BAD_INPUT });
  });
});

const PUBLIC_TEXT = [
  "Input is limited by UTF-8 bytes and decoded with strict JSON and a trusted shape validator; malformed or incomplete input is refused.",
  "The library returns results to its caller and does not print a report.",
];
const builtEntry = fileURLToPath(new URL("../dist/private-store/json.js", import.meta.url));
const trees: string[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) {
    rmSync(tree, { recursive: true, force: true });
  }
});

function fixtureTree(): string {
  const tree = mkdtempSync(join(dirname(builtEntry), "json-witness-"));
  trees.push(tree);
  return tree;
}

// Original trace preloads. Runtime loading and reporting are outside the explicitly bracketed entry.
const FS_PRELOAD = String.raw`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

let active = false;
let calls = [];

function wrap(owner, prefix) {
  for (const name of Object.keys(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor || typeof descriptor.value !== "function" || !/^[a-z]/.test(name)) {
      continue;
    }
    const original = descriptor.value;
    const observed = function (...args) {
      if (active) {
        calls.push({ op: prefix + name });
      }
      return Reflect.apply(original, this, args);
    };
    Object.assign(observed, original);
    owner[name] = observed;
  }
}

wrap(fs.promises, "fs.promises.");
wrap(fs, "fs.");
syncBuiltinESMExports();

export const trace = {
  start() {
    calls = [];
    active = true;
  },
  stop() {
    active = false;
    return calls.slice();
  },
};
`;

const EFFECT_PRELOAD = String.raw`
import childProcess from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import workers from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";

let active = false;
let calls = [];

function hook(owner, name, label) {
  const original = owner[name];
  if (typeof original !== "function") {
    return;
  }
  const observed = function (...args) {
    if (active) {
      calls.push({ op: label });
      throw new Error("effect attempt recorded and blocked");
    }
    if (new.target) {
      return Reflect.construct(original, args, new.target);
    }
    return Reflect.apply(original, this, args);
  };
  Object.setPrototypeOf(observed, original);
  observed.prototype = original.prototype;
  owner[name] = observed;
}

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  hook(childProcess, name, "child_process." + name);
}
hook(childProcess.ChildProcess.prototype, "spawn", "ChildProcess.spawn");
for (const name of ["connect", "createConnection", "createServer"]) {
  hook(net, name, "net." + name);
}
hook(net.Socket.prototype, "connect", "Socket.connect");
hook(net.Server.prototype, "listen", "Server.listen");
for (const [owner, label] of [[http, "http"], [https, "https"]]) {
  for (const name of ["request", "get", "createServer"]) {
    hook(owner, name, label + "." + name);
  }
  hook(owner.Agent.prototype, "createConnection", label + ".Agent.createConnection");
}
for (const [owner, label] of [[dns, "dns"], [dns.promises, "dns.promises"]]) {
  for (const name of Object.keys(owner).filter((name) => /^(lookup|resolve|reverse)/.test(name))) {
    hook(owner, name, label + "." + name);
  }
}
hook(workers, "Worker", "worker_threads.Worker");
hook(globalThis, "fetch", "fetch");
syncBuiltinESMExports();

export const trace = {
  start() {
    calls = [];
    active = true;
  },
  stop() {
    active = false;
    return calls.slice();
  },
};
`;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  messages: unknown[];
}

function childFixture(path: string, preloads: string[] = [], input = "", payload = ""): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const args = preloads.flatMap((preload) => ["--import", pathToFileURL(preload).href]);
    const child = spawn(process.execPath, [...args, path, payload], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, JSON_PAYLOAD: payload },
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    const messages: unknown[] = [];
    child.on("error", reject);
    child.stdout.on("data", (bytes) => stdout += bytes);
    child.stderr.on("data", (bytes) => stderr += bytes);
    child.on("message", (message) => messages.push(message));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, messages }));
    child.stdin.end(input);
  });
}

function installTraces(tree: string): string[] {
  const fs = join(tree, "fs-trace.mjs");
  const effects = join(tree, "effects-trace.mjs");
  writeFileSync(fs, FS_PRELOAD);
  writeFileSync(effects, EFFECT_PRELOAD);
  return [fs, effects];
}

function matrixFixture(tree: string): string {
  const path = join(tree, "matrix.mjs");
  const source = `
import { decodeStrictJson } from ${JSON.stringify(pathToFileURL(builtEntry).href)};
import { trace as fsTrace } from "./fs-trace.mjs";
import { trace as effectTrace } from "./effects-trace.mjs";

const INPUT_CAP = ${INPUT_CAP};
const STRING_CAP = ${STRING_CAP};
const MAX_INPUT = ${MAX_INPUT};
const PUBLIC_TEXT = ${JSON.stringify(PUBLIC_TEXT, null, 2)};
${accepted.toString()}
${refused.toString()}
${decoderCases.toString()}
${codecCases.toString()}
${makeCodec.toString()}

function equal(actual, expected) {
  if (actual === null || typeof actual !== "object" || expected === null || typeof expected !== "object") {
    return Object.is(actual, expected);
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    return false;
  }
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every((key) =>
    Object.hasOwn(expected, key) && equal(actual[key], expected[key]));
}

const codec = makeCodec();
const observations = [];

function exercise(label, bytes, limits, expected, useCodec) {
  fsTrace.start();
  effectTrace.start();
  let result;
  try {
    const decoded = decodeStrictJson(bytes, limits);
    const value = useCodec ? codec(decoded) : decoded;
    result = { accepted: true, matches: equal(value, expected) };
  } catch (error) {
    result = { code: error.code, message: error.message, typeError: error instanceof TypeError, cause: "cause" in error };
  }
  observations.push({ label, result, filesystem: fsTrace.stop(), effects: effectTrace.stop() });
}

for (const entry of decoderCases()) {
  exercise(entry.label, entry.bytes, entry.limits, entry.value, false);
}
for (const entry of codecCases()) {
  exercise(entry.label, Buffer.from(entry.text), {}, entry.value, true);
}
let stdin = "";
for await (const bytes of process.stdin) {
  stdin += bytes;
}
const channels = [["arguments", process.argv[2]], ["environment", process.env.JSON_PAYLOAD], ["stdin", stdin]];
for (const [label, text] of channels) {
  exercise(label, Buffer.from(text), {}, codecCases()[1].value, true);
}
await new Promise((resolve, reject) => {
  process.send({ publicText: PUBLIC_TEXT, observations }, (error) => error ? reject(error) : resolve());
});
process.disconnect();
`;
  writeFileSync(path, source);
  return path;
}

describe("admission_public_text_matches_entry_matrix", () => {
  it("pins the decoder sentences to real values, fixed errors, and zero filesystem or external calls", async () => {
    const tree = fixtureTree();
    const preloads = installTraces(tree);
    const payload = codecCases()[1].text;
    const child = await childFixture(matrixFixture(tree), preloads, payload, payload);
    expect([child.code, child.signal, child.stdout, child.stderr]).toEqual([0, null, "", ""]);
    expect(child.messages).toHaveLength(1);
    const packet = child.messages[0] as {
      publicText: string[];
      observations: { label: string; result: unknown; filesystem: unknown[]; effects: unknown[] }[];
    };
    const expected = [
      ...decoderCases().map((entry) => ({ label: entry.label, code: entry.code })),
      ...codecCases().map((entry) => ({ label: entry.label, code: entry.code })),
      ...["arguments", "environment", "stdin"].map((label) => ({ label, code: undefined })),
    ];
    expect(packet.publicText).toEqual(PUBLIC_TEXT);
    expect(packet.observations.map((entry) => entry.label)).toEqual(expected.map((entry) => entry.label));
    for (let index = 0; index < expected.length; index++) {
      const observation = packet.observations[index];
      const entry = expected[index];
      // K1.12
      expect(observation.effects, `${entry.label}: no external calls`).toEqual([]);
      // K1.12
      expect(observation.filesystem, `${entry.label}: no filesystem calls`).toEqual([]);
      const message = entry.code === "BAD_SHAPE" ? "invalid snapshot shape" : MESSAGES[entry.code as keyof typeof MESSAGES];
      expect(observation.result, entry.label).toEqual(entry.code
        ? { code: entry.code, message, typeError: false, cause: false }
        : { accepted: true, matches: true });
    }
    console.info(JSON.stringify({ publicText: packet.publicText, observations: packet.observations }));
  });

  it("calibrates both preloads against actual filesystem and blocked external-call attempts", async () => {
    const tree = fixtureTree();
    const preloads = installTraces(tree);
    const path = join(tree, "calibration.mjs");
    writeFileSync(path, String.raw`
import fs from "node:fs";
import childProcess from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { Worker } from "node:worker_threads";
import { trace as fsTrace } from "./fs-trace.mjs";
import { trace as effectTrace } from "./effects-trace.mjs";

fsTrace.start();
effectTrace.start();
fs.readFileSync(import.meta.filename);
for (const attempt of [
  () => childProcess.spawn("unused"),
  () => net.connect(1),
  () => http.request("http://example.invalid/"),
  () => https.request("https://example.invalid/"),
  () => dns.lookup("example.invalid"),
  () => new Worker("unused"),
  () => fetch("https://example.invalid/"),
]) {
  try {
    attempt();
  } catch {
    // The trace intercepts attempts before a process, socket, or worker can start.
  }
}
const packet = { filesystem: fsTrace.stop(), effects: effectTrace.stop() };
await new Promise((resolve, reject) => {
  process.send(packet, (error) => error ? reject(error) : resolve());
});
process.disconnect();
`);
    const child = await childFixture(path, preloads);
    expect([child.code, child.signal, child.stdout, child.stderr]).toEqual([0, null, "", ""]);
    const packet = child.messages[0] as { filesystem: { op: string }[]; effects: { op: string }[] };
    expect(packet.filesystem.map((entry) => entry.op)).toContain("fs.readFileSync");
    expect(packet.effects.map((entry) => entry.op)).toEqual([
      "child_process.spawn", "net.connect", "http.request", "https.request", "dns.lookup", "worker_threads.Worker", "fetch",
    ]);
    console.info(JSON.stringify({ calibration: packet }));
  });
});

function reportFixture(tree: string): string {
  const path = join(tree, "report.mjs");
  writeFileSync(path, `
import { decodeStrictJson } from ${JSON.stringify(pathToFileURL(builtEntry).href)};

const value = decodeStrictJson(Buffer.from(JSON.stringify({ report: "x".repeat(16 * 1024) })));
const report = JSON.stringify(value) + "\\n";
process.stdout.on("error", () => {});

function deliver(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, (error) => resolve(error ? error.code : null));
  });
}

const resume = new Promise((resolve) => process.once("message", resolve));
const prefixError = await deliver(report.slice(0, 100));
await new Promise((resolve, reject) => {
  process.send({ paused: true, prefixError }, (error) => error ? reject(error) : resolve());
});
await resume;
const deliveryError = await deliver(report.slice(100));
await new Promise((resolve, reject) => {
  process.send({ deliveryError, reportBytes: Buffer.byteLength(report) }, (error) => error ? reject(error) : resolve());
});
process.disconnect();
`);
  return path;
}

function pipeReport(path: string, closeAfterPrefix: boolean): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe", "ipc"], timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    let paused = false;
    let resumed = false;
    const messages: unknown[] = [];
    function resume(): void {
      if (!paused || stdout.length !== 100 || resumed) {
        return;
      }
      resumed = true;
      if (closeAfterPrefix) {
        child.stdout.destroy();
      }
      child.send("resume");
    }
    child.on("error", reject);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      resume();
    });
    child.stderr.on("data", (bytes) => stderr += bytes);
    child.on("message", (message) => {
      messages.push(message);
      if ((message as { paused?: boolean }).paused) {
        paused = true;
        resume();
      }
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, messages }));
    child.stdin.end();
  });
}

it("reporting fixture awaits delivery and retains the measured prefix after the reader closes", async () => {
  const tree = fixtureTree();
  const path = reportFixture(tree);
  const report = JSON.stringify({ report: "x".repeat(16 * 1024) }) + "\n";
  const positive = await pipeReport(path, false);
  expect([positive.code, positive.signal, positive.stderr, positive.stdout]).toEqual([0, null, "", report]);
  expect(positive.messages).toEqual([
    { paused: true, prefixError: null }, { deliveryError: null, reportBytes: Buffer.byteLength(report) },
  ]);
  const failed = await pipeReport(path, true);
  expect([failed.code, failed.signal, failed.stderr]).toEqual([0, null, ""]);
  expect(failed.stdout).toBe(report.slice(0, 100));
  expect(failed.messages).toHaveLength(2);
  expect(failed.messages[0]).toEqual({ paused: true, prefixError: null });
  const delivery = failed.messages[1] as { deliveryError: string; reportBytes: number };
  expect(delivery.deliveryError).toBe("EPIPE");
  expect(delivery.reportBytes).toBe(Buffer.byteLength(report));
  console.info(JSON.stringify({ retainedPrefixBytes: Buffer.byteLength(failed.stdout), exit: failed.code, ...delivery }));
});
