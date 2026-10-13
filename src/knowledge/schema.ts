// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Shapes, limits and validators of the knowledge demo. Everything a transport returns is
 * untrusted bytes: it is size-checked, decoded and matched against an exact shape before any
 * field is used. Nothing here repairs a bad reply.
 */
import { createHash } from "node:crypto";

export const MAX_REPLY_BYTES = 8 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024;
export const MAX_EXCERPT_BYTES = 1024;
export const QUESTION_IDS = ["invoice-terms", "approval-threshold"] as const;

export type QuestionId = typeof QUESTION_IDS[number];
export type ErrorCode = "USAGE" | "UNAVAILABLE" | "DENIED" | "STALE" | "INVALID_RESPONSE" | "TIMEOUT";

export type Binding = {
  connection: "demo";
  principal: "demo-reader";
  collection: "demo-company";
};

export type Request = Binding & {
  schema_version: 1;
  question_id: QuestionId;
  query: string;
};

export type CitationRef = {
  document_id: string;
  revision: number;
  fragment: string;
  sha256: string;
};

export type Transport = {
  lookup(request: Request, signal: AbortSignal): Promise<Uint8Array>;
  revalidate(binding: Binding, ref: CitationRef, signal: AbortSignal): Promise<Uint8Array>;
};

export type Passage = CitationRef & { state: "current"; excerpt: string };

export type LookupReply = {
  principal: string;
  collection: string;
  passages: Passage[];
};

export type CheckReply = CitationRef & {
  principal: string;
  collection: string;
  state: "current" | "revoked";
};

export type Output = {
  status: "OK";
  mode: "synthetic";
  question_id: QuestionId;
  answer: string;
  citation: CitationRef & { retrieved_at: string; checked_at: string };
};

/** A refusal with its stable code. The message is the code: no reply content travels in it. */
export class Refusal extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "Refusal";
  }
}

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const SHA = /^[a-f0-9]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Terminal controls (C0, DEL, C1) and surrogate halves, which have no UTF-8 form. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f]|\p{Surrogate}/u;

const LOOKUP_KEYS = ["schema_version", "principal", "collection", "passages"];
const PASSAGE_KEYS = ["document_id", "revision", "fragment", "sha256", "state", "excerpt"];
const CHECK_KEYS = ["schema_version", "principal", "collection", "document_id", "revision", "fragment", "sha256", "state"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** No key outside `keys`. A missing key fails the check of its own field. */
function hasOnlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

function isId(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}

function isRef(o: Record<string, unknown>): boolean {
  if (!isId(o.document_id) || !isId(o.fragment)) return false;
  if (!Number.isSafeInteger(o.revision) || Number(o.revision) <= 0) return false;
  return typeof o.sha256 === "string" && SHA.test(o.sha256);
}

function isExcerpt(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0 || UNSAFE_TEXT.test(v)) return false;
  return Buffer.byteLength(v, "utf8") <= MAX_EXCERPT_BYTES;
}

function isPassage(p: unknown): boolean {
  if (!isObject(p) || !hasOnlyKeys(p, PASSAGE_KEYS) || !isRef(p)) return false;
  return p.state === "current" && isExcerpt(p.excerpt);
}

function invalid(): Refusal {
  return new Refusal("INVALID_RESPONSE");
}

export function digest(excerpt: string): string {
  return createHash("sha256").update(excerpt, "utf8").digest("hex");
}

/** Reply bytes to a JSON value. The size cap comes first, then a strict UTF-8 decode. */
export function decode(bytes: unknown): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_REPLY_BYTES) throw invalid();
  try {
    // ignoreBOM leaves a leading byte-order mark in the text, where the parser refuses it.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw invalid();
  }
}

export function lookupReply(value: unknown): LookupReply {
  if (!isObject(value) || !hasOnlyKeys(value, LOOKUP_KEYS) || value.schema_version !== 1) throw invalid();
  if (!isId(value.principal) || !isId(value.collection)) throw invalid();
  if (!Array.isArray(value.passages) || value.passages.length > 1) throw invalid();
  if (!value.passages.every(isPassage)) throw invalid();
  return value as LookupReply;
}

export function checkReply(value: unknown): CheckReply {
  if (!isObject(value) || !hasOnlyKeys(value, CHECK_KEYS) || value.schema_version !== 1) throw invalid();
  if (!isId(value.principal) || !isId(value.collection) || !isRef(value)) throw invalid();
  if (value.state !== "current" && value.state !== "revoked") throw invalid();
  return value as CheckReply;
}

/**
 * The clock's reading as canonical UTC text with milliseconds. A reading outside the four-digit
 * years has no such form, and a result without its times is not reported.
 */
export function canonicalTime(value: Date): string {
  const text = value.toISOString();
  if (!TIME.test(text)) throw new Refusal("UNAVAILABLE");
  return text;
}

/** The one success line, without its newline. */
export function serializeOutput(output: Output): string {
  const text = JSON.stringify(output);
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) throw invalid();
  return text;
}
