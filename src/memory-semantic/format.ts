// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { decodeStrictJson, StrictJsonError } from "../private-store/json.js";

export const LIMITS = Object.freeze({
  manifest: 64 * 1024, rows: 1024 * 1024, metadata: 1024 * 1024,
  rowLine: 8 * 1024, shard: 2 * 1024 * 1024, shards: 2 * 1024 * 1024,
  total: 3 * 1024 * 1024, entries: 18,
});

export type RefusalCode = "BAD_FORMAT" | "LIMIT";
export class SemanticFormatError extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
    this.name = "SemanticFormatError";
  }
}

export interface SemanticDirectoryInput {
  manifest: Iterable<Uint8Array>;
  rows: Iterable<Uint8Array>;
  shards: Iterable<{ name: string; chunks: Iterable<Uint8Array> }>;
}
export interface SemanticSummary { rows: number; dimension: number; shards: number }
interface Scope { kind: string; userStoreId: string; workspaceId: string }
interface Shard { name: string; byteCount: number; rowCount: number; sha256: string }
interface Manifest {
  datasetId: string; scopeBinding: Scope; modelFingerprint: string;
  dimension: number; rowCount: number; shards: Shard[];
}

const manifestKeys = [
  "schemaVersion", "datasetId", "scopeBinding", "generation", "modelFingerprint",
  "dimension", "rowCount", "status", "shards",
];
const scopeKeys = ["kind", "userStoreId", "workspaceId"];
const shardKeys = ["name", "byteCount", "rowCount", "sha256"];
const rowKeys = [
  "datasetId", "scopeBinding", "id", "revision", "digest", "sourceRevision", "sourceHash",
  "chunkStart", "chunkEnd", "chunkHash", "embeddingInputHash", "modelFingerprint",
];
const token = /^[A-Za-z0-9_-]{1,128}$/;
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shardPattern = /^vectors-[0-9]{4}\.f32$/;

function refuse(code: RefusalCode = "BAD_FORMAT"): never { throw new SemanticFormatError(code); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  const found = Object.keys(value);
  if (found.length !== keys.length || found.some((key) => !keys.includes(key))) refuse();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) refuse();
  if (value > max) refuse("LIMIT");
  return value;
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) refuse();
  return value;
}
function scope(value: unknown): Scope {
  const fields = object(value, scopeKeys);
  if (fields.kind !== "personal") refuse();
  return {
    kind: "personal", userStoreId: string(fields.userStoreId, token),
    workspaceId: string(fields.workspaceId, token),
  };
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.kind === b.kind && a.userStoreId === b.userStoreId && a.workspaceId === b.workspaceId;
}
function bytes(chunks: Iterable<Uint8Array>, max: number): Buffer {
  let result = Buffer.alloc(0);
  let length = 0;
  let count = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) refuse();
    if (++count > max + 1) refuse("LIMIT");
    if (chunk.byteLength > max - length) refuse("LIMIT");
    if (chunk.byteLength === 0) continue;
    const needed = length + chunk.byteLength;
    if (needed > result.byteLength) {
      const next = Buffer.alloc(Math.min(max, Math.max(needed, result.byteLength * 2, 64 * 1024)));
      result.copy(next, 0, 0, length);
      result = next;
    }
    result.set(chunk, length);
    length += chunk.byteLength;
  }
  return result.subarray(0, length);
}
function json(data: Uint8Array, max: number): unknown {
  if (data.byteLength >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) refuse();
  try {
    return decodeStrictJson(data, {
      maxInputBytes: max, maxDepth: 8, maxArrayLength: 1000,
      maxObjectKeys: 32, maxStringBytes: max,
    });
  } catch (error) {
    if (error instanceof StrictJsonError) refuse(error.code === "TOO_LARGE" ? "LIMIT" : "BAD_FORMAT");
    return refuse();
  }
}
function parseManifest(data: Uint8Array): Manifest {
  const fields = object(json(data, LIMITS.manifest), manifestKeys);
  if (fields.schemaVersion !== 1 || fields.status !== "complete") refuse();
  const dimension = integer(fields.dimension, 1, 1536);
  const rowCount = integer(fields.rowCount, 1, 1000);
  if (!Array.isArray(fields.shards) || fields.shards.length < 1) refuse();
  if (fields.shards.length > 16) refuse("LIMIT");
  let rows = 0;
  let shardBytes = 0;
  const shards = fields.shards.map((value, index): Shard => {
    const item = object(value, shardKeys);
    const name = string(item.name, shardPattern);
    if (name !== "vectors-" + index.toString().padStart(4, "0") + ".f32") refuse();
    const count = integer(item.rowCount, 1, 4096);
    const byteCount = integer(item.byteCount, 20, LIMITS.shard);
    const expected = 20 + count * dimension * 4;
    if (!Number.isSafeInteger(expected) || byteCount !== expected) refuse();
    rows += count;
    shardBytes += byteCount;
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(shardBytes)) refuse("LIMIT");
    return { name, byteCount, rowCount: count, sha256: string(item.sha256, hex) };
  });
  if (rows !== rowCount) refuse();
  if (shardBytes > LIMITS.shards) refuse("LIMIT");
  return {
    datasetId: string(fields.datasetId, token),
    scopeBinding: scope(fields.scopeBinding),
    modelFingerprint: string(fields.modelFingerprint, hex),
    dimension, rowCount, shards,
  };
}
function validateRows(data: Uint8Array, source: Manifest): void {
  const ids = new Set<string>();
  let start = 0;
  let count = 0;
  for (let index = 0; index < data.byteLength; index++) {
    if (data[index] === 0x0d) refuse();
    if (data[index] !== 0x0a) {
      if (index - start >= LIMITS.rowLine) refuse("LIMIT");
      continue;
    }
    const line = data.subarray(start, index);
    if (line.byteLength === 0) refuse();
    const row = object(json(line, LIMITS.rowLine), rowKeys);
    if (row.datasetId !== source.datasetId || row.modelFingerprint !== source.modelFingerprint) refuse();
    if (!sameScope(scope(row.scopeBinding), source.scopeBinding)) refuse();
    const id = string(row.id, uuid);
    if (ids.has(id)) refuse();
    ids.add(id);
    integer(row.revision, 1);
    integer(row.sourceRevision, 1);
    const chunkStart = integer(row.chunkStart, 0);
    const chunkEnd = integer(row.chunkEnd, 1);
    if (chunkEnd <= chunkStart) refuse();
    for (const key of ["digest", "sourceHash", "chunkHash", "embeddingInputHash"]) string(row[key], hex);
    count++;
    if (count > source.rowCount) refuse();
    start = index + 1;
  }
  if (start !== data.byteLength || count !== source.rowCount) refuse();
}
function validateShard(data: Buffer, declaration: Shard, source: Manifest): void {
  if (data.byteLength !== declaration.byteCount || data.byteLength < 20) refuse();
  if (data.toString("ascii", 0, 8) !== "ORCHVEC1") refuse();
  if (data.readUInt32LE(8) !== 1 || data.readUInt32LE(12) !== source.dimension) refuse();
  if (data.readUInt32LE(16) !== declaration.rowCount) refuse();
  if (createHash("sha256").update(data).digest("hex") !== declaration.sha256) refuse();
  for (let row = 0; row < declaration.rowCount; row++) {
    let norm = 0;
    for (let column = 0; column < source.dimension; column++) {
      const value = data.readFloatLE(20 + (row * source.dimension + column) * 4);
      if (!Number.isFinite(value)) refuse();
      norm += value * value;
    }
    if (!Number.isFinite(norm) || norm === 0 || Math.abs(norm - 1) > 0.001) refuse();
  }
}

/** Validate supplied bytes without filesystem, store, model, or process access. */
export function validateSemanticDirectory(input: SemanticDirectoryInput): SemanticSummary {
  try {
    const manifestBytes = bytes(input.manifest, LIMITS.manifest);
    const source = parseManifest(manifestBytes);
    const rowBytes = bytes(input.rows, LIMITS.rows);
    if (manifestBytes.byteLength + rowBytes.byteLength > LIMITS.metadata) refuse("LIMIT");
    if (manifestBytes.byteLength + rowBytes.byteLength +
      source.shards.reduce((sum, item) => sum + item.byteCount, 0) > LIMITS.total) refuse("LIMIT");
    validateRows(rowBytes, source);
    let index = 0;
    let actualTotal = manifestBytes.byteLength + rowBytes.byteLength;
    for (const supplied of input.shards) {
      if (index >= source.shards.length || supplied.name !== source.shards[index].name) refuse();
      const shard = bytes(supplied.chunks, LIMITS.shard);
      actualTotal += shard.byteLength;
      if (actualTotal > LIMITS.total) refuse("LIMIT");
      validateShard(shard, source.shards[index], source);
      index++;
    }
    if (index !== source.shards.length) refuse();
    return { rows: source.rowCount, dimension: source.dimension, shards: source.shards.length };
  } catch (error) {
    if (error instanceof SemanticFormatError) throw error;
    return refuse();
  }
}
