// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The personal learning document: exact validation, canonical JSON and the SHA-256 digest.
 *
 * One document shape is the input, the saved output and the input of every later command.
 * Every byte of it is untrusted: extra keys are refused at each level, numbers must be safe
 * integers, times must round-trip as UTC ISO with milliseconds. An error carries a fixed code
 * and never a part of the input.
 */
import { createHash } from "node:crypto";

/** Cap on the input and on the output, in UTF-8 bytes. */
export const MAX_BYTES = 65_536;
export const MAX_EVENTS = 20;
export const MAX_REJECTIONS = 100;
export const MAX_DRAFTS = 5;
const MAX_NOTE_BYTES = 1024;
const MAX_LIFETIME_MS = 90 * 86_400_000;

export const DISPLAY_NOTE = "Proposed display settings and quoted notes only; current instructions take precedence; nothing has been applied.";

export type SettingKey = "response-language" | "answer-length";

export type SettingsSnapshotV1 = {
  schema_version: 1;
  revision: number;
  values: Partial<Record<SettingKey, string>>;
};

export type DeletedEvent = { event_id: string; event_revision: number; state: "deleted" };

type ActiveBase = {
  event_id: string;
  event_revision: number;
  state: "active";
  recorded_at: string;
  expires_at: string;
};

export type SettingEvent = ActiveBase & { kind: "setting-correction"; key: SettingKey; value: string };
export type LessonEvent = ActiveBase & { kind: "lesson-note"; text: string };
export type ActiveEvent = SettingEvent | LessonEvent;
export type Event = DeletedEvent | ActiveEvent;

export type Draft = {
  id: string;
  status: "DRAFT";
  authority: "user-supplied-unverified";
  evaluation: "not-run";
  event_id: string;
  event_revision: number;
  kind: "setting" | "lesson";
  effect: Record<string, unknown>;
  expires_at: string;
  conflict: boolean;
};

export type Rejection = { id: string };

export type LearningDocumentV1 = {
  schema_version: 1;
  scope: "personal";
  revision: number;
  settings: SettingsSnapshotV1 | null;
  events: Event[];
  rejections: Rejection[];
  source_digest: string | null;
  drafts: Draft[];
  omitted_event_ids: string[];
};

export type ErrorCode = "INVALID_INPUT" | "CONFLICT" | "STALE" | "NOT_FOUND" | "LIMIT" | "TIMEOUT" | "USAGE";

export class LearningError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

const DOCUMENT_KEYS = ["schema_version", "scope", "revision", "settings", "events", "rejections", "source_digest", "drafts", "omitted_event_ids"];
const SETTINGS_KEYS = ["schema_version", "revision", "values"];
const DELETED_KEYS = ["event_id", "event_revision", "state"];
const ACTIVE_KEYS = [...DELETED_KEYS, "recorded_at", "expires_at", "kind"];
const SETTING_EVENT_KEYS = [...ACTIVE_KEYS, "key", "value"];
const LESSON_EVENT_KEYS = [...ACTIVE_KEYS, "text"];
const DRAFT_KEYS = ["id", "status", "authority", "evaluation", "event_id", "event_revision", "kind", "effect", "expires_at", "conflict"];
const SETTING_EFFECT_KEYS = ["key", "before", "before_known", "expected_settings_revision", "after"];
const LESSON_EFFECT_KEYS = ["quoted_note"];

const EVENT_ID = /^[a-z][a-z0-9-]{0,47}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/**
 * Terminal control characters refused in a note: the C0 set without tab and newline (so
 * carriage return and escape are refused), DEL, and the C1 set, which JSON output does not escape.
 */
const NOTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function invalid(): never {
  throw new LearningError("INVALID_INPUT");
}

/** An object written as `{...}` in JSON: not null, not an array, no other prototype. */
function plain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Exactly these keys: none missing, none extra. */
function exact(o: Record<string, unknown>, keys: string[]): void {
  const own = Object.keys(o);
  if (own.length !== keys.length || own.some((k) => !keys.includes(k))) invalid();
}

function safe(n: unknown, positive = false): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= (positive ? 1 : 0);
}

function idOk(s: unknown): s is string {
  return typeof s === "string" && EVENT_ID.test(s);
}

function hashOk(s: unknown): s is string {
  return typeof s === "string" && SHA256_HEX.test(s);
}

function iso(s: unknown): s is string {
  return typeof s === "string" && ISO_MS.test(s) && new Date(s).toISOString() === s;
}

function settingValue(key: unknown, value: unknown): boolean {
  if (key === "response-language") return value === "en" || value === "zh";
  if (key === "answer-length") return value === "short" || value === "normal";
  return false;
}

function noteOk(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const bytes = Buffer.byteLength(text);
  return bytes >= 1 && bytes <= MAX_NOTE_BYTES && !NOTE_CONTROL.test(text);
}

function validateSettings(v: unknown): asserts v is SettingsSnapshotV1 | null {
  if (v === null) return;
  if (!plain(v)) invalid();
  exact(v, SETTINGS_KEYS);
  if (v.schema_version !== 1 || !safe(v.revision) || !plain(v.values)) invalid();
  const values = v.values;
  if (Object.keys(values).some((k) => !settingValue(k, values[k]))) invalid();
}

function validateEvent(v: unknown): asserts v is Event {
  if (!plain(v) || !idOk(v.event_id) || !safe(v.event_revision, true)) invalid();
  if (v.state === "deleted") {
    exact(v, DELETED_KEYS);
    return;
  }
  if (v.state !== "active") invalid();
  if (!iso(v.recorded_at) || !iso(v.expires_at)) invalid();
  const lifetime = Date.parse(v.expires_at) - Date.parse(v.recorded_at);
  if (lifetime < 0 || lifetime > MAX_LIFETIME_MS) invalid();
  if (v.kind === "setting-correction") {
    exact(v, SETTING_EVENT_KEYS);
    if (!settingValue(v.key, v.value)) invalid();
  } else if (v.kind === "lesson-note") {
    exact(v, LESSON_EVENT_KEYS);
    if (!noteOk(v.text)) invalid();
  } else {
    invalid();
  }
}

function validateSettingEffect(effect: Record<string, unknown>): void {
  exact(effect, SETTING_EFFECT_KEYS);
  if (!settingValue(effect.key, effect.after) || typeof effect.before_known !== "boolean") invalid();
  if (effect.before !== null && typeof effect.before !== "string") invalid();
  if (effect.expected_settings_revision !== null && !safe(effect.expected_settings_revision)) invalid();
}

function validateDraft(v: unknown): asserts v is Draft {
  if (!plain(v)) invalid();
  exact(v, DRAFT_KEYS);
  if (!hashOk(v.id) || v.status !== "DRAFT" || v.authority !== "user-supplied-unverified" || v.evaluation !== "not-run") invalid();
  if (!idOk(v.event_id) || !safe(v.event_revision, true) || !iso(v.expires_at)) invalid();
  if (typeof v.conflict !== "boolean" || !plain(v.effect)) invalid();
  if (v.kind === "lesson") {
    exact(v.effect, LESSON_EFFECT_KEYS);
    if (typeof v.effect.quoted_note !== "string") invalid();
  } else if (v.kind === "setting") {
    validateSettingEffect(v.effect);
  } else {
    invalid();
  }
}

function validateRejection(v: unknown): asserts v is Rejection {
  if (!plain(v)) invalid();
  exact(v, ["id"]);
  if (!hashOk(v.id)) invalid();
}

/** Decode and validate one document. Throws LearningError with a fixed code. */
export function parseDocument(bytes: Uint8Array | string): LearningDocumentV1 {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  if (buffer.length > MAX_BYTES) throw new LearningError("LIMIT");
  // Fatal decoding: bytes that are not UTF-8 throw here and the command reports INVALID_INPUT.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!plain(v)) invalid();
  exact(v, DOCUMENT_KEYS);
  if (v.schema_version !== 1 || v.scope !== "personal" || !safe(v.revision)) invalid();
  if (!Array.isArray(v.events) || !Array.isArray(v.rejections) || !Array.isArray(v.drafts) || !Array.isArray(v.omitted_event_ids)) invalid();
  if (v.source_digest !== null && !hashOk(v.source_digest)) invalid();
  validateSettings(v.settings);
  // Events are counted before duplicates are merged; rejection markers are counted once per ID.
  if (v.events.length > MAX_EVENTS || v.drafts.length > MAX_DRAFTS) throw new LearningError("LIMIT");
  v.events.forEach(validateEvent);
  v.drafts.forEach(validateDraft);
  v.rejections.forEach(validateRejection);
  if (new Set(v.rejections.map((r: Rejection) => r.id)).size > MAX_REJECTIONS) throw new LearningError("LIMIT");
  if (v.omitted_event_ids.some((id) => !idOk(id))) invalid();
  return v as LearningDocumentV1;
}

/** Canonical JSON: object keys sorted at every level, array order kept, no whitespace. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (plain(v)) {
    const members = Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`);
    return `{${members.join(",")}}`;
  }
  const s = JSON.stringify(v);
  if (s === undefined) invalid();
  return s;
}

/** SHA-256 of the canonical JSON, lowercase hex. It detects a changed value, not who wrote it. */
export function digest(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
