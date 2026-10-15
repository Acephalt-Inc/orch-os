// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from "vitest";
import {
  check, fingerprint, makeFixture, makeHugeMetadataFixture, refreshShard, rowObjects, setRows,
} from "./fixtures/memory-semantic/fixture.js";

function refused(f: ReturnType<typeof makeFixture>, code = "BAD_FORMAT") {
  expect(() => check(f)).toThrowError(expect.objectContaining({ code }));
}

describe("semantic directory format", () => {
  it("valid_normalized_fixture_summary", () => {
    expect(check(makeFixture())).toEqual({ rows: 2, dimension: 2, shards: 1 });
  });

  it("tampered_shard_digest_refused", () => {
    const f = makeFixture();
    f.shard[20] ^= 1;
    refused(f);
  });

  it("wrong_dimension_refused", () => {
    const f = makeFixture();
    f.shard.writeUInt32LE(3, 12);
    refreshShard(f);
    refused(f);
  });

  it("duplicate_identity_refused", () => {
    const f = makeFixture();
    const rows = rowObjects(f);
    rows[1].id = rows[0].id;
    rows[1].revision = 2;
    setRows(f, rows);
    refused(f);
  });

  it("nonfinite_float_refused", () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      const f = makeFixture();
      f.shard.writeFloatLE(value, 20);
      refreshShard(f);
      refused(f);
    }
  });

  it("extra_trailing_byte_refused", () => {
    const f = makeFixture();
    f.shard = Buffer.concat([f.shard, Buffer.from([0])]);
    refreshShard(f);
    refused(f);
  });

  it("huge_metadata_refused", () => {
    const f = makeHugeMetadataFixture();
    expect(f.rows.length).toBeLessThanOrEqual(1024 * 1024);
    expect(f.rows.length + f.manifestBytes.length).toBe(1024 * 1024 + 1);
    refused(f, "LIMIT");
  });

  it("oversized_files_refused", () => {
    const f = makeFixture();
    const metadata = Buffer.byteLength(JSON.stringify(f.manifest)) + f.rows.length;
    f.shard = Buffer.alloc(3 * 1024 * 1024 + 1 - metadata);
    expect(metadata + f.shard.length).toBe(3 * 1024 * 1024 + 1);
    refused(f, "LIMIT");
    const g = makeHugeMetadataFixture();
    const otherMetadata = g.manifestBytes!.length + g.rows.length;
    g.shard = Buffer.alloc(3 * 1024 * 1024 + 1 - otherMetadata);
    expect(otherMetadata + g.shard.length).toBe(3 * 1024 * 1024 + 1);
    expect(g.shard.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    refused(g, "LIMIT");
  });

  it("invalid_utf8_refused", () => {
    const f = makeFixture();
    f.manifestBytes = Buffer.from([0xff]);
    refused(f);
    const g = makeFixture();
    g.rows = Buffer.from([0xff, 0x0a]);
    refused(g);
  });

  it("duplicate_json_key_refused", () => {
    const f = makeFixture();
    const raw = JSON.stringify(f.manifest);
    f.manifestBytes = Buffer.from(raw.replace('"datasetId":', '"datasetId":"other","\\u0064atasetId":'));
    refused(f);
    const g = makeFixture();
    g.rows = Buffer.from(g.rows.toString().replace('"id":', '"id":"other","\\u0069d":'));
    refused(g);
  });

  it("deep_json_refused", () => {
    const f = makeFixture();
    const raw = JSON.stringify(f.manifest).replace('"status":"complete"', '"status":' + "[".repeat(9) + "0" + "]".repeat(9));
    f.manifestBytes = Buffer.from(raw);
    refused(f, "LIMIT");
  });

  it("empty_file_refused", () => {
    const f = makeFixture();
    f.manifestBytes = Buffer.alloc(0);
    refused(f);
  });

  it("non_normalized_vector_refused", () => {
    const f = makeFixture();
    f.shard.writeFloatLE(2, 20);
    refreshShard(f);
    refused(f);
  });

  it("missing_listed_shard_refused", () => {
    const f = makeFixture();
    expect(() => check(f, [])).toThrowError(expect.objectContaining({ code: "BAD_FORMAT" }));
  });

  it("shard_name_pattern_refused", () => {
    const f = makeFixture();
    for (const name of ["../vectors-0000.f32", "vectors-00xx.f32", "vectors-0001.f32"]) {
      f.manifest.shards[0].name = name;
      refused(f);
    }
  });

  it("wrong_header_version_and_short_read_refused", () => {
    for (const offset of [0, 8]) {
      const f = makeFixture();
      f.shard[offset] ^= 1;
      refreshShard(f);
      refused(f);
    }
    const f = makeFixture();
    f.shard = f.shard.subarray(0, -1);
    refused(f);
  });

  it("excess_row_and_missing_lf_refused", () => {
    const f = makeFixture();
    f.rows = Buffer.concat([f.rows, f.rows.subarray(0, f.rows.indexOf(10) + 1)]);
    refused(f);
    const g = makeFixture();
    g.rows = g.rows.subarray(0, -1);
    refused(g);
  });

  it("unsafe_integer_and_partial_status_refused", () => {
    const f = makeFixture();
    f.manifest.generation = Number.MAX_SAFE_INTEGER + 1;
    refused(f);
    const g = makeFixture();
    g.manifest.status = "partial";
    refused(g);
  });

  it("zero_vector_refused", () => {
    const f = makeFixture();
    f.shard.writeFloatLE(0, 20);
    refreshShard(f);
    refused(f);
  });

  it("row_identity_and_claim_shape_refused", () => {
    const f = makeFixture();
    const rows = rowObjects(f);
    rows[0].id = "UPPERCASE";
    setRows(f, rows);
    refused(f);
    const g = makeFixture();
    const other = rowObjects(g);
    other[0].modelFingerprint = "b".repeat(64);
    setRows(g, other);
    refused(g);
    const h = makeFixture();
    const span = rowObjects(h);
    span[0].chunkEnd = 0;
    setRows(h, span);
    refused(h);
    expect(fingerprint).toHaveLength(64);
  });
});
