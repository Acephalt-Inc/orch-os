// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { partitionPaths, type Binding } from "../private-store/binding.js";
import type { SnapshotCodec } from "../private-store/snapshot.js";

export type Scope = { kind: "personal"; userStoreId: string; workspaceId: string };
export type Source = {
  sourceId: string; kind: "supplied-text"; locator: "user-statement"; revision: 1; sha256: string;
  capturedAt: string; byteLength: number; scope: Scope; expiresAt: string; text: string;
  fragmentStart: number; fragmentEnd: number; quote: string;
};
export type Fact = {
  schemaVersion: 1; id: string; revision: 1; parentRevision: null; digest: string; scope: Scope;
  kind: "fact"; title: string; assertion: string; polarity: "affirmed" | "negated" | "uncertain"; assertionKey: null;
  sources: [Source]; time: {
    recordedAt: string; updatedAt: string; eventTime: null; validTime: null; expiresAt: string; reviewDueAt: null;
  }; capturedBy: "explicit"; packetId: null;
  entities: []; relations: []; state: "active"; verification: "unverified"; conflictIds: []; review: null;
  lineage: {
    derivedFrom: []; evidencePacket: null; coverageGeneration: null; evidenceCount: 1;
    supersedes: null; supersededBy: null; replacedAt: null;
  };
};
export type Tombstone = { schemaVersion: 1; id: string; deletedAt: string; sequence: number };
export type Payload = { schemaVersion: 1; facts: Fact[]; tombstones: Tombstone[]; lastObservedAt: string };
export type Submission = { title: string; assertion: string; polarity: Fact["polarity"]; source: {
  text: string; fragmentStart: number; fragmentEnd: number; quote: string;
} };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const LABEL_CONTROL = /[\p{Cc}\p{Bidi_Control}]/u;
const EXPIRES_MS = 90 * 86_400_000;

export class MemoryShapeError extends Error {
  constructor(readonly kind: "INVALID" | "LIMIT") { super(kind); }
}
function invalid(): never { throw new MemoryShapeError("INVALID"); }
function limit(): never { throw new MemoryShapeError("LIMIT"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: unknown, expected: string[]): Record<string, unknown> {
  const row = object(value);
  const found = Object.keys(row).sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected.slice().sort()[index])) invalid();
  return row;
}
function string(value: unknown, max: number, min = 0): string {
  if (typeof value !== "string" || !(value as string & { isWellFormed(): boolean }).isWellFormed()) invalid();
  const bytes = Buffer.byteLength(value);
  if (bytes > max) limit();
  if (bytes < min) invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) invalid();
  return value;
}
function positive(value: unknown, zero = true): number {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) invalid();
  return value as number;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !HEX.test(value)) invalid();
  return value;
}
export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

// Same observable code-point key order, JSON scalar spelling and array order as the private store.
function compare(a: string, b: string): number {
  const left = Array.from(a, (part) => part.codePointAt(0)!);
  const right = Array.from(b, (part) => part.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = object(value);
  return `{${Object.keys(row).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

export function scopeFor(binding: Binding): Scope {
  const directory = partitionPaths(binding).directory;
  const home = dirname(dirname(dirname(dirname(directory))));
  return { kind: "personal", userStoreId: hash(`user-store-v1\0${home}`), workspaceId: basename(directory) };
}
function sameScope(value: unknown, expected: Scope): Scope {
  const row = keys(value, ["kind", "userStoreId", "workspaceId"]);
  if (row.kind !== expected.kind || row.userStoreId !== expected.userStoreId || row.workspaceId !== expected.workspaceId) invalid();
  return expected;
}
export function checkSpan(text: string, start: number, end: number, quote: string): void {
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length) invalid();
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, start));
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
  } catch { invalid(); }
  if (!Buffer.from(quote, "utf8").equals(bytes.subarray(start, end))) invalid();
}
export function submission(value: unknown): Submission {
  const row = keys(value, ["title", "assertion", "polarity", "source"]);
  const source = keys(row.source, ["text", "fragmentStart", "fragmentEnd", "quote"]);
  const title = string(row.title, 256, 1);
  if (LABEL_CONTROL.test(title)) invalid();
  const assertion = string(row.assertion, 4096, 1);
  const text = string(source.text, 8192, 1);
  const quote = string(source.quote, 4096, 1);
  const fragmentStart = positive(source.fragmentStart);
  const fragmentEnd = positive(source.fragmentEnd, false);
  checkSpan(text, fragmentStart, fragmentEnd, quote);
  if (!["affirmed", "negated", "uncertain"].includes(row.polarity as string)) invalid();
  return { title, assertion, polarity: row.polarity as Fact["polarity"],
    source: { text, fragmentStart, fragmentEnd, quote } };
}
function sourceFrom(value: unknown, expected: Scope, expiresAt: string, recordedAt: string): Source {
  const row = keys(value, ["sourceId", "kind", "locator", "revision", "sha256", "capturedAt", "byteLength", "scope",
    "expiresAt", "text", "fragmentStart", "fragmentEnd", "quote"]);
  uuid(row.sourceId);
  sha(row.sha256);
  const text = string(row.text, 8192, 1);
  const quote = string(row.quote, 4096, 1);
  if (row.kind !== "supplied-text" || row.locator !== "user-statement" || row.revision !== 1
    || row.capturedAt !== recordedAt || row.expiresAt !== expiresAt || row.byteLength !== Buffer.byteLength(text)
    || row.sha256 !== hash(text)) invalid();
  sameScope(row.scope, expected);
  checkSpan(text, positive(row.fragmentStart), positive(row.fragmentEnd, false), quote);
  return row as Source;
}
function factFrom(value: unknown, expected: Scope): Fact {
  const row = keys(value, ["schemaVersion", "id", "revision", "parentRevision", "digest", "scope", "kind", "title",
    "assertion", "polarity", "assertionKey", "sources", "time", "capturedBy", "packetId",
    "entities", "relations", "state", "verification", "conflictIds", "review", "lineage"]);
  const time = keys(row.time, ["recordedAt", "updatedAt", "eventTime", "validTime", "expiresAt", "reviewDueAt"]);
  const lineage = keys(row.lineage, ["derivedFrom", "evidencePacket", "coverageGeneration", "evidenceCount",
    "supersedes", "supersededBy", "replacedAt"]);
  uuid(row.id);
  sha(row.digest);
  sameScope(row.scope, expected);
  const recordedAt = timestamp(time.recordedAt);
  const expiresAt = timestamp(time.expiresAt);
  if (Date.parse(expiresAt) - Date.parse(recordedAt) !== EXPIRES_MS || time.updatedAt !== recordedAt) invalid();
  const title = string(row.title, 256, 1);
  if (LABEL_CONTROL.test(title)) invalid();
  string(row.assertion, 4096, 1);
  if (!["affirmed", "negated", "uncertain"].includes(row.polarity as string)) invalid();
  if (!Array.isArray(row.sources) || row.sources.length !== 1) invalid();
  sourceFrom(row.sources[0], expected, expiresAt, recordedAt);
  for (const name of ["entities", "relations", "conflictIds"]) {
    if (!Array.isArray(row[name]) || (row[name] as unknown[]).length !== 0) invalid();
  }
  if (!Array.isArray(lineage.derivedFrom) || lineage.derivedFrom.length !== 0) invalid();
  for (const name of ["parentRevision", "assertionKey", "packetId", "review"]) {
    if (row[name] !== null) invalid();
  }
  for (const name of ["eventTime", "validTime", "reviewDueAt"]) if (time[name] !== null) invalid();
  for (const name of ["evidencePacket", "coverageGeneration", "supersedes", "supersededBy", "replacedAt"]) {
    if (lineage[name] !== null) invalid();
  }
  if (row.schemaVersion !== 1 || row.revision !== 1 || row.kind !== "fact" || row.capturedBy !== "explicit"
    || row.state !== "active" || row.verification !== "unverified" || lineage.evidenceCount !== 1) invalid();
  const { digest, ...unsigned } = row;
  if (digest !== hash(canonical(unsigned)) || Buffer.byteLength(canonical(row)) > 16 * 1024) invalid();
  return row as Fact;
}
export function memoryCodec(binding: Binding): SnapshotCodec<Payload> {
  const expected = scopeFor(binding);
  return {
    encode: (value) => value,
    decode(value) {
      const row = keys(value, ["schemaVersion", "facts", "tombstones", "lastObservedAt"]);
      if (row.schemaVersion !== 1 || !Array.isArray(row.facts) || !Array.isArray(row.tombstones)
        || row.facts.length + row.tombstones.length > 1000) invalid();
      timestamp(row.lastObservedAt);
      const ids = new Set<string>();
      const hashes = new Set<string>();
      let prior = "";
      for (const value of row.facts) {
        const fact = factFrom(value, expected);
        if (fact.id <= prior || ids.has(fact.id) || hashes.has(fact.sources[0].sha256)) invalid();
        ids.add(fact.id);
        hashes.add(fact.sources[0].sha256);
        prior = fact.id;
      }
      prior = "";
      for (const value of row.tombstones) {
        const tomb = keys(value, ["schemaVersion", "id", "deletedAt", "sequence"]);
        uuid(tomb.id);
        timestamp(tomb.deletedAt);
        positive(tomb.sequence, false);
        if (tomb.schemaVersion !== 1 || (tomb.id as string) <= prior || ids.has(tomb.id as string)) invalid();
        ids.add(tomb.id as string);
        prior = tomb.id as string;
      }
      return row as Payload;
    },
  };
}
export function makeFact(input: Submission, scope: Scope, id: string, sourceId: string, at: string): Fact {
  uuid(id);
  uuid(sourceId);
  timestamp(at);
  const expiresAt = new Date(Date.parse(at) + EXPIRES_MS).toISOString();
  const source: Source = { sourceId, kind: "supplied-text", locator: "user-statement", revision: 1,
    sha256: hash(input.source.text), capturedAt: at, byteLength: Buffer.byteLength(input.source.text), scope,
    expiresAt, text: input.source.text, fragmentStart: input.source.fragmentStart,
    fragmentEnd: input.source.fragmentEnd, quote: input.source.quote };
  const unsigned = { schemaVersion: 1 as const, id, revision: 1 as const, parentRevision: null, scope, kind: "fact" as const,
    title: input.title, assertion: input.assertion, polarity: input.polarity, assertionKey: null, sources: [source] as [Source],
    time: { recordedAt: at, updatedAt: at, eventTime: null, validTime: null, expiresAt, reviewDueAt: null },
    capturedBy: "explicit" as const, packetId: null, entities: [] as [], relations: [] as [], state: "active" as const,
    verification: "unverified" as const, conflictIds: [] as [], review: null,
    lineage: { derivedFrom: [] as [], evidencePacket: null, coverageGeneration: null, evidenceCount: 1 as const,
      supersedes: null, supersededBy: null, replacedAt: null } };
  const fact: Fact = { ...unsigned, digest: hash(canonical(unsigned)) };
  if (Buffer.byteLength(canonical(fact)) > 16 * 1024) limit();
  return fact;
}
