// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * JSON text in the exact layout v1.1 wrote (Python `json.dumps` defaults): `", "` between
 * items, `": "` after keys, non-ASCII escaped as \uXXXX, and `indent=N` layout when asked.
 * State files written by v2 are therefore byte-compatible with files written by v1.1.
 */

function str(s: string): string {
  return JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function num(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  return String(n);
}

export function dumps(v: unknown, indent?: number): string {
  return enc(v, indent, 0);
}

function enc(v: unknown, indent: number | undefined, depth: number): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return str(v);
  const nl = indent === undefined ? "" : "\n" + " ".repeat(indent * (depth + 1));
  const end = indent === undefined ? "" : "\n" + " ".repeat(indent * depth);
  const sep = indent === undefined ? ", " : ",";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map((x) => nl + enc(x, indent, depth + 1)).join(sep) + end + "]";
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object).filter((k) => (v as any)[k] !== undefined);
    if (keys.length === 0) return "{}";
    return "{" + keys.map((k) => nl + str(k) + ": " + enc((v as any)[k], indent, depth + 1)).join(sep) + end + "}";
  }
  return "null";
}
