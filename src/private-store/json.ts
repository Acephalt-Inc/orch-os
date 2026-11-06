// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0

export interface JsonLimits {
  maxInputBytes?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringBytes?: number;
}

/** Only trusted importing code supplies functions; input bytes never select a seam. */
export interface JsonSeam {
  decoded?: (value: unknown) => void;
}

export class StrictJsonError extends Error {
  constructor(readonly code: "BAD_INPUT" | "TOO_LARGE") {
    super(code === "BAD_INPUT" ? "invalid strict JSON input" : "strict JSON input exceeds limits");
    this.name = "StrictJsonError";
  }
}

const DEFAULTS: Required<JsonLimits> = {
  maxInputBytes: 256 * 1024,
  maxDepth: 8,
  maxArrayLength: 1_000,
  maxObjectKeys: 32,
  maxStringBytes: 256 * 1024,
};
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function fail(code: "BAD_INPUT" | "TOO_LARGE" = "BAD_INPUT"): never {
  throw new StrictJsonError(code);
}

function boundedLimits(input: JsonLimits): Required<JsonLimits> {
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof JsonLimits)[]) {
    const value = input[key] ?? DEFAULTS[key];
    const ceiling = key === "maxInputBytes" ? MAX_INPUT_BYTES : DEFAULTS[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) fail();
    limits[key] = value;
  }
  return limits;
}

/** Fatal UTF-8 and a complete bounded grammar precede any caller's shape validation. */
export function decodeStrictJson(bytes: Uint8Array, limits: JsonLimits = {}, seam: JsonSeam = {}): unknown {
  try {
    const bounds = boundedLimits(limits);
    if (!(bytes instanceof Uint8Array)) fail();
    if (bytes.byteLength > bounds.maxInputBytes) fail("TOO_LARGE");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const result = parseJson(text, bounds);
    seam.decoded?.(result);
    return result;
  } catch (error) {
    if (error instanceof StrictJsonError) throw error;
    return fail();
  }
}

function parseJson(text: string, limits: Required<JsonLimits>): unknown {
  let index = 0;
  const numberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  function whitespace(): void {
    while (index < text.length && /[ \t\r\n]/.test(text[index])) {
      index++;
    }
  }

  function string(): string {
    index++;
    let result = "";
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        // String.prototype.isWellFormed() rejects decoded lone surrogates on Node >=22.
        if (!(result as string & { isWellFormed(): boolean }).isWellFormed()) fail();
        if (Buffer.byteLength(result, "utf8") > limits.maxStringBytes) fail("TOO_LARGE");
        return result;
      }
      if (character === "\\") {
        const escape = text[index++];
        if (escape === "u") {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          if (!Object.hasOwn(ESCAPES, escape)) fail();
          result += ESCAPES[escape];
        }
      } else {
        if (character.charCodeAt(0) < 0x20) fail();
        result += character;
      }
      // UTF-16 units never exceed UTF-8 bytes for a well-formed string; bound accumulation too.
      if (result.length > limits.maxStringBytes) fail("TOO_LARGE");
    }
    return fail();
  }

  function container(depth: number, array: boolean): unknown {
    if (depth >= limits.maxDepth) fail("TOO_LARGE");
    index++;
    const entries: unknown[] = [];
    const object: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();
    const end = array ? "]" : "}";
    whitespace();
    if (text[index] === end) {
      index++;
      return array ? entries : object;
    }
    for (;;) {
      if (array) {
        if (entries.length >= limits.maxArrayLength) fail("TOO_LARGE");
        entries.push(value(depth + 1));
      } else {
        whitespace();
        if (text[index] !== '"') fail();
        const key = string();
        if (key === "__proto__" || key === "prototype" || key === "constructor") fail();
        if (keys.has(key)) fail();
        if (keys.size >= limits.maxObjectKeys) fail("TOO_LARGE");
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") fail();
        object[key] = value(depth + 1);
      }
      whitespace();
      const separator = text[index++];
      if (separator === end) return array ? entries : object;
      if (separator !== ",") fail();
    }
  }

  function value(depth: number): unknown {
    whitespace();
    const character = text[index];
    if (character === '"') return string();
    if (character === "[" || character === "{") return container(depth, character === "[");
    for (const literal of ["null", "true", "false"] as const) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return literal === "null" ? null : literal === "true";
      }
    }
    numberToken.lastIndex = index;
    const token = numberToken.exec(text);
    if (!token) return fail();
    index = numberToken.lastIndex;
    const result = Number(token[0]);
    if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) fail();
    return result;
  }

  const result = value(0);
  whitespace();
  if (index !== text.length) fail();
  return result;
}
