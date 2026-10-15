// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSemanticDirectory } from "../../../src/memory-semantic/format.js";

export const fingerprint = "a".repeat(64);
export const scopeBinding = { kind: "personal", userStoreId: "user_1", workspaceId: "work_1" };
export const id = (n: number) => "00000000-0000-4000-8000-" + n.toString().padStart(12, "0");
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface Fixture {
  manifest: Record<string, any>;
  rows: Buffer;
  shard: Buffer;
  manifestBytes?: Buffer;
}

export function makeFixture(): Fixture {
  const shard = Buffer.alloc(20 + 2 * 2 * 4);
  shard.write("ORCHVEC1", 0, "ascii");
  shard.writeUInt32LE(1, 8);
  shard.writeUInt32LE(2, 12);
  shard.writeUInt32LE(2, 16);
  shard.writeFloatLE(1, 20);
  shard.writeFloatLE(0, 24);
  shard.writeFloatLE(0, 28);
  shard.writeFloatLE(1, 32);
  const manifest = {
    schemaVersion: 1, datasetId: "data_1", scopeBinding, generation: 1, modelFingerprint: fingerprint,
    dimension: 2, rowCount: 2, status: "complete",
    shards: [{ name: "vectors-0000.f32", byteCount: shard.length, rowCount: 2, sha256: hash(shard) }],
  };
  const row = (n: number) => ({
    datasetId: "data_1", scopeBinding, id: id(n), revision: 1, digest: fingerprint,
    sourceRevision: 1, sourceHash: fingerprint, chunkStart: 0, chunkEnd: 1,
    chunkHash: fingerprint, embeddingInputHash: fingerprint, modelFingerprint: fingerprint,
  });
  const rows = Buffer.from(JSON.stringify(row(1)) + "\n" + JSON.stringify(row(2)) + "\n");
  return { manifest, rows, shard };
}

export function makeHugeMetadataFixture(): Fixture {
  const f = makeFixture();
  const row = rowObjects(f)[0];
  const repeated = Array.from({ length: 200 }, (_, n) => ({ ...row, id: id(n + 1) }));
  f.manifest.rowCount = 200;
  f.manifest.shards[0].rowCount = 200;
  f.shard = Buffer.alloc(20 + 200 * 2 * 4);
  f.shard.write("ORCHVEC1", 0, "ascii");
  f.shard.writeUInt32LE(1, 8);
  f.shard.writeUInt32LE(2, 12);
  f.shard.writeUInt32LE(200, 16);
  for (let n = 0; n < 200; n++) f.shard.writeFloatLE(1, 20 + n * 8);
  refreshShard(f);
  const manifest = Buffer.from(JSON.stringify(f.manifest));
  f.manifestBytes = Buffer.concat([manifest, Buffer.alloc(65536 - manifest.length, 0x20)]);
  f.rows = Buffer.from(repeated.map((r, n) => JSON.stringify(r) + " ".repeat(4298 + (n < 41 ? 1 : 0)) + "\n").join(""));
  return f;
}

export function refreshShard(f: Fixture): void {
  f.manifest.shards[0].byteCount = f.shard.length;
  f.manifest.shards[0].sha256 = hash(f.shard);
}

export function setRows(f: Fixture, rows: Record<string, any>[]): void {
  f.rows = Buffer.from(rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

export function rowObjects(f: Fixture): Record<string, any>[] {
  return f.rows.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

export function check(f: Fixture, shards: { name: string; chunks: Uint8Array[] }[] = [
  { name: "vectors-0000.f32", chunks: [f.shard] },
]) {
  return validateSemanticDirectory({
    manifest: [f.manifestBytes ?? Buffer.from(JSON.stringify(f.manifest))],
    rows: [f.rows], shards,
  });
}

export function writeFixture(path: string, f: Fixture): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "manifest.json"), f.manifestBytes ?? JSON.stringify(f.manifest));
  writeFileSync(join(path, "rows.jsonl"), f.rows);
  writeFileSync(join(path, "vectors-0000.f32"), f.shard);
}
