// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from "vitest";
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
  const valid = [{ label: "valid table", text: JSON.stringify(value), value }];
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
