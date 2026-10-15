import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindWorkspace } from "../src/private-store/binding.js";
import { mutateSnapshot, readSnapshot } from "../src/private-store/snapshot.js";
import { canonical, hash, makeFact, memoryCodec, scopeFor, type Submission } from "../src/memory/schema.js";

const input: Submission = {
  title: "Blue sky",
  assertion: "The sky is blue.",
  polarity: "affirmed",
  source: { text: "blue", fragmentStart: 0, fragmentEnd: 4, quote: "blue" },
};
const id = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000002";

describe("memory fact schema", () => {
  it("memory guide is in the repository and out of the pinned npm docs set", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(readFileSync("docs/memory.md", "utf8")).toContain("orch memory add");
    expect(pkg.files).not.toContain("docs/memory.md");
  });
  it("uses the ruled 22-key fact with bounded nested objects", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "memory-schema-"));
    const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5000);
    const fact = makeFact(input, scopeFor(binding), id, sourceId, "2026-10-15T00:00:00.000Z");
    expect(Object.keys(fact)).toHaveLength(22);
    expect(Object.keys(fact.time).sort()).toEqual([
      "eventTime", "expiresAt", "recordedAt", "reviewDueAt", "updatedAt", "validTime",
    ]);
    expect(Object.keys(fact.lineage).sort()).toEqual([
      "coverageGeneration", "derivedFrom", "evidenceCount", "evidencePacket", "replacedAt", "supersededBy", "supersedes",
    ]);
    const payload = { schemaVersion: 1 as const, facts: [fact], tombstones: [], lastObservedAt: "2026-10-15T00:00:00.000Z" };
    expect(memoryCodec(binding).decode(payload)).toEqual(payload);
  });

  it("refuses extra fact and time keys", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "memory-schema-"));
    const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5000);
    const fact = makeFact(input, scopeFor(binding), id, sourceId, "2026-10-15T00:00:00.000Z");
    const codec = memoryCodec(binding);
    const payload = (value: unknown) => ({
      schemaVersion: 1, facts: [value], tombstones: [], lastObservedAt: "2026-10-15T00:00:00.000Z",
    });
    expect(() => codec.decode(payload({ ...fact, extra: null }))).toThrow();
    expect(() => codec.decode(payload({ ...fact, time: { ...fact.time, extra: null } }))).toThrow();
  });

  it("refuses a stored title carrying a bidi control even with a matching digest", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "memory-schema-"));
    const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5000);
    const fact = makeFact(input, scopeFor(binding), id, sourceId, "2026-10-15T00:00:00.000Z");
    const codec = memoryCodec(binding);
    const signed = (title: string) => {
      const { digest: _digest, ...unsigned } = { ...fact, title };
      return { ...unsigned, digest: hash(canonical(unsigned)) };
    };
    const payload = (value: unknown) => ({
      schemaVersion: 1, facts: [value], tombstones: [], lastObservedAt: "2026-10-15T00:00:00.000Z",
    });
    expect(codec.decode(payload(signed("a b")))).toBeTruthy();
    expect(() => codec.decode(payload(signed("a\u061cb")))).toThrow();
    expect(() => codec.decode(payload(signed("a\u2067b")))).toThrow();
  });

  it("matches private store canonical bytes and hashes the complete nested record", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "memory-schema-"));
    const binding = await bindWorkspace(workspace, "memory-v1", performance.now() + 5000);
    const fact = makeFact(input, scopeFor(binding), id, sourceId, "2026-10-15T00:00:00.000Z");
    const { digest, ...unsigned } = fact;
    expect(digest).toBe(hash(canonical(unsigned)));
    const probe = { "\u{1f600}": [1, true, null, "\\\"\n"], "\ue000": { z: -2.5, a: "é" }, a: 0 };
    const codec = memoryCodec(binding);
    const payload = { schemaVersion: 1 as const, facts: [fact], tombstones: [], lastObservedAt: "2026-10-15T00:00:00.000Z" };
    const written = await mutateSnapshot(binding, codec, 0, performance.now() + 5000, () => payload);
    expect(written.status).toBe("written");
    const observed = await readSnapshot(binding, codec, performance.now() + 5000, () => probe);
    expect(observed.status).toBe("read");
    if (observed.status === "read") expect(observed.output).toEqual(Buffer.from(canonical(probe) + "\n"));
  });
});
