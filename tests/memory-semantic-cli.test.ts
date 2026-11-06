// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeFixture, makeHugeMetadataFixture, refreshShard, rowObjects, setRows, writeFixture,
} from "./fixtures/memory-semantic/fixture.js";

const cli = resolve("dist/cli.js");
const observer = resolve("tests/fixtures/memory-semantic/observer.cjs");
const roots: string[] = [];
const valid = { status: 0, stdout: "semantic validate: VALID rows=2 dimension=2 shards=1\n", stderr: "" };
const refused = { status: 1, stdout: "", stderr: "semantic validate: REFUSED\n" };
const usage = { status: 2, stdout: "", stderr: "semantic validate: USAGE\n" };

function scratch(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "semantic-validate-"));
  roots.push(path);
  return path;
}
function fixtureDir(): string {
  const path = scratch();
  writeFixture(path, makeFixture());
  return path;
}
function run(args: string[], watched = false) {
  const call = watched ? ["--require", observer, cli] : [cli];
  const result = spawnSync(process.execPath, [...call, "memory", ...args], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function validate(path: string, watched = false) {
  return run(["semantic", "validate", "--dir", path], watched);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("installed semantic validate command", () => {
  it("valid_normalized_fixture_summary", () => {
    expect(validate(fixtureDir())).toEqual(valid);
  });

  it("tampered_shard_digest_refused", () => {
    const path = fixtureDir();
    const name = join(path, "vectors-0000.f32");
    const bytes = readFileSync(name);
    bytes[20] ^= 1;
    writeFileSync(name, bytes);
    expect(validate(path)).toEqual(refused);
  });

  it("wrong_dimension_refused", () => {
    const path = scratch();
    const f = makeFixture();
    f.shard.writeUInt32LE(3, 12);
    refreshShard(f);
    writeFixture(path, f);
    expect(validate(path)).toEqual(refused);
  });

  it("duplicate_identity_refused", () => {
    const path = scratch();
    const f = makeFixture();
    const rows = rowObjects(f);
    rows[1].id = rows[0].id;
    rows[1].revision = 2;
    setRows(f, rows);
    writeFixture(path, f);
    expect(validate(path)).toEqual(refused);
  });

  it("nonfinite_float_refused", () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      const path = scratch();
      const f = makeFixture();
      f.shard.writeFloatLE(value, 20);
      refreshShard(f);
      writeFixture(path, f);
      expect(validate(path)).toEqual(refused);
    }
  });

  it("extra_trailing_byte_refused", () => {
    const path = scratch();
    const f = makeFixture();
    f.shard = Buffer.concat([f.shard, Buffer.from([0])]);
    refreshShard(f);
    writeFixture(path, f);
    expect(validate(path)).toEqual(refused);
  });

  it("huge_metadata_refused", () => {
    const path = scratch();
    writeFixture(path, makeHugeMetadataFixture());
    expect(validate(path)).toEqual(refused);
  });

  it("oversized_files_refused", () => {
    const path = scratch();
    const f = makeFixture();
    const metadata = Buffer.byteLength(JSON.stringify(f.manifest)) + f.rows.length;
    f.shard = Buffer.alloc(3 * 1024 * 1024 + 1 - metadata);
    writeFixture(path, f);
    expect(validate(path)).toEqual(refused);
    const forged = scratch();
    const g = makeHugeMetadataFixture();
    const otherMetadata = g.manifestBytes!.length + g.rows.length;
    g.shard = Buffer.alloc(3 * 1024 * 1024 + 1 - otherMetadata);
    writeFixture(forged, g);
    expect(validate(forged)).toEqual(refused);
  });

  it("invalid_utf8_duplicate_key_and_empty_file_refused", () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from('{"x":1,"x":2}'), Buffer.alloc(0)]) {
      const path = fixtureDir();
      writeFileSync(join(path, "manifest.json"), bytes);
      expect(validate(path)).toEqual(refused);
    }
  });

  it("row_utf8_and_decoded_duplicate_key_refused", () => {
    const badUtf8 = fixtureDir();
    writeFileSync(join(badUtf8, "rows.jsonl"), Buffer.from([0xff, 0x0a]));
    expect(validate(badUtf8)).toEqual(refused);
    const duplicate = fixtureDir();
    const f = makeFixture();
    const row = f.rows.toString().replace('"id":', '"id":"other","\\u0069d":');
    writeFileSync(join(duplicate, "rows.jsonl"), row);
    expect(validate(duplicate)).toEqual(refused);
    const manifestDuplicate = fixtureDir();
    const raw = JSON.stringify(f.manifest).replace('"datasetId":', '"datasetId":"other","\\u0064atasetId":');
    writeFileSync(join(manifestDuplicate, "manifest.json"), raw);
    expect(validate(manifestDuplicate)).toEqual(refused);
  });

  it("deep_json_refused", () => {
    const path = fixtureDir();
    const manifest = JSON.stringify(makeFixture().manifest);
    const nested = manifest.replace('"status":"complete"', '"status":' + "[".repeat(9) + "0" + "]".repeat(9));
    writeFileSync(join(path, "manifest.json"), nested);
    expect(validate(path)).toEqual(refused);
  });

  it("non_normalized_vector_refused", () => {
    const path = scratch();
    const f = makeFixture();
    f.shard.writeFloatLE(2, 20);
    refreshShard(f);
    writeFixture(path, f);
    expect(validate(path)).toEqual(refused);
  });

  it("wrong_header_short_read_excess_row_unsafe_integer_zero_vector_and_partial_status_refused", () => {
    const header = scratch();
    const h = makeFixture();
    h.shard.writeUInt32LE(2, 8);
    refreshShard(h);
    writeFixture(header, h);
    expect(validate(header)).toEqual(refused);
    const short = scratch();
    const s = makeFixture();
    s.shard = s.shard.subarray(0, -1);
    writeFixture(short, s);
    expect(validate(short)).toEqual(refused);
    const excess = scratch();
    const e = makeFixture();
    e.rows = Buffer.concat([e.rows, e.rows.subarray(0, e.rows.indexOf(10) + 1)]);
    writeFixture(excess, e);
    expect(validate(excess)).toEqual(refused);
    const unsafe = scratch();
    const u = makeFixture();
    u.manifest.generation = Number.MAX_SAFE_INTEGER + 1;
    writeFixture(unsafe, u);
    expect(validate(unsafe)).toEqual(refused);
    const zero = scratch();
    const z = makeFixture();
    z.shard.writeFloatLE(0, 20);
    refreshShard(z);
    writeFixture(zero, z);
    expect(validate(zero)).toEqual(refused);
    const partial = scratch();
    const p = makeFixture();
    p.manifest.status = "partial";
    writeFixture(partial, p);
    expect(validate(partial)).toEqual(refused);
  });

  it("extra_directory_entry_refused", () => {
    for (const name of ["extra", ".hidden"]) {
      const path = fixtureDir();
      writeFileSync(join(path, name), "");
      expect(validate(path)).toEqual(refused);
    }
    const path = fixtureDir();
    mkdirSync(join(path, "extra"));
    expect(validate(path)).toEqual(refused);
    const linked = fixtureDir();
    symlinkSync(join(linked, "rows.jsonl"), join(linked, "extra"));
    expect(validate(linked)).toEqual(refused);
  });

  it("missing_listed_shard_refused", () => {
    const path = fixtureDir();
    unlinkSync(join(path, "vectors-0000.f32"));
    expect(validate(path)).toEqual(refused);
  });

  it("unlisted_shard_refused", () => {
    const path = fixtureDir();
    writeFileSync(join(path, "vectors-0001.f32"), readFileSync(join(path, "vectors-0000.f32")));
    expect(validate(path)).toEqual(refused);
  });

  it("shard_name_pattern_refused", () => {
    const path = scratch();
    const f = makeFixture();
    f.manifest.shards[0].name = "../vectors-0000.f32";
    writeFixture(path, f);
    expect(validate(path)).toEqual(refused);
  });

  it("manifest_link_refused", () => {
    const path = fixtureDir();
    const source = join(scratch(), "source.json");
    renameSync(join(path, "manifest.json"), source);
    symlinkSync(source, join(path, "manifest.json"));
    expect(validate(path)).toEqual(refused);
  });

  it("directory_path_is_file_refused", () => {
    const path = fixtureDir();
    expect(validate(join(path, "manifest.json"))).toEqual(refused);
  });

  it("unsafe_file_type_refused", () => {
    const path = fixtureDir();
    const link = scratch();
    symlinkSync(path, join(link, "directory"));
    expect(validate(join(link, "directory"))).toEqual(refused);
    expect(validate(join(link, "directory") + "/")).toEqual(refused);
    expect(validate(join(link, "directory") + "/.")).toEqual(refused);
    const hard = fixtureDir();
    linkSync(join(hard, "rows.jsonl"), join(hard, "rows-copy"));
    expect(validate(hard)).toEqual(refused);
    unlinkSync(join(hard, "rows-copy"));
    const source = join(scratch(), "rows-copy");
    linkSync(join(hard, "rows.jsonl"), source);
    expect(validate(hard)).toEqual(refused);
    const nonregular = fixtureDir();
    unlinkSync(join(nonregular, "manifest.json"));
    mkdirSync(join(nonregular, "manifest.json"));
    expect(validate(nonregular)).toEqual(refused);
  });

  it("path_component_resolution_refused", () => {
    const root = scratch();
    writeFixture(join(root, "actual"), makeFixture());
    const other = join(root, "other");
    const bad = makeFixture();
    bad.shard[20] ^= 1;
    writeFixture(join(other, "actual"), bad);
    mkdirSync(join(other, "child"));
    symlinkSync(join(other, "child"), join(root, "alias"));
    expect(validate(join(root, "alias") + "/../actual")).toEqual(refused);
  });

  it("missing_path_file_permission_and_malicious_bytes_refused", () => {
    const path = fixtureDir();
    expect(validate(join(path, "missing\n\u202e"))).toEqual(refused);
    unlinkSync(join(path, "rows.jsonl"));
    expect(validate(path)).toEqual(refused);
    const denied = fixtureDir();
    chmodSync(denied, 0);
    try { expect(validate(denied)).toEqual(refused); }
    finally { chmodSync(denied, 0o700); }
  });

  it("wrong_command_shape_is_fixed_usage", () => {
    const path = fixtureDir();
    for (const args of [
      [], ["semantic"], ["semantic", "validate"], ["semantic", "validate", "--dir"],
      ["semantic", "validate", "--dir", ""],
      ["semantic", "validate", "--dir", path, "--dir", path],
      ["semantic", "validate", "--dir", path, "--unknown=\n\u202e"],
    ]) expect(run(args)).toEqual(usage);
  });

  it("validation_makes_no_filesystem_write_process_or_network_call", () => {
    const path = fixtureDir();
    expect(validate(path, true)).toEqual(valid);
    writeFileSync(join(path, "extra"), "");
    expect(validate(path, true)).toEqual(refused);
  });
});
