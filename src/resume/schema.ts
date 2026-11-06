// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
export const MAX_INPUT_BYTES = 4096;
export const MAX_FIELD_BYTES = 1024;

export interface ResumeNote {
  objective: string;
  next_step: string;
  reported_progress: string;
}

export interface ResumeRecord {
  schema: 1;
  id: string;
  revision: number;
  saved_at: string;
  note?: ResumeNote;
}

export class ResumeError extends Error {
  constructor(readonly status: "invalid" | "conflict" | "unavailable", message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
}

export function parseNote(input: Buffer): ResumeNote {
  if (input.length > MAX_INPUT_BYTES) throw new ResumeError("invalid", "input exceeds 4 KiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ResumeError("invalid", "input is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ResumeError("invalid", "input is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ["objective", "next_step", "reported_progress"])) {
    throw new ResumeError("invalid", "note must contain exactly objective, next_step and reported_progress");
  }
  const note = value as Record<keyof ResumeNote, unknown>;
  for (const key of ["objective", "next_step", "reported_progress"] as const) {
    if (typeof note[key] !== "string" || Buffer.byteLength(note[key]) > MAX_FIELD_BYTES) {
      throw new ResumeError("invalid", `${key} must be text of at most 1024 UTF-8 bytes`);
    }
  }
  return note as ResumeNote;
}

export function parseRecord(input: Buffer): ResumeRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    throw new ResumeError("unavailable", "stored state is corrupt");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ResumeError("unavailable", "stored state is corrupt");
  const record = value as Record<string, unknown>;
  const keys = record.note === undefined ? ["schema", "id", "revision", "saved_at"] : ["schema", "id", "revision", "saved_at", "note"];
  if (!exactKeys(record, keys) || record.schema !== 1 || typeof record.id !== "string" || typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.saved_at !== "string") {
    throw new ResumeError("unavailable", "stored state has an unknown schema or is corrupt");
  }
  if (record.note !== undefined) {
    const encoded = Buffer.from(JSON.stringify(record.note));
    let parsed: ResumeNote;
    try { parsed = parseNote(encoded); } catch { throw new ResumeError("unavailable", "stored state is corrupt"); }
    record.note = parsed;
  }
  return record as unknown as ResumeRecord;
}
