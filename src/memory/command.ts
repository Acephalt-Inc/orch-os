// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { randomUUID } from "node:crypto";
import { readSync } from "node:fs";
import { bindWorkspace } from "../private-store/binding.js";
import { PrivateStoreError } from "../private-store/errors.js";
import { decodeStrictJson, StrictJsonError } from "../private-store/json.js";
import { mutateSnapshot, readSnapshot, type SnapshotContext, type SnapshotSeam } from "../private-store/snapshot.js";
import { display } from "./display.js";
import { parseRecall, prepareRecall, projectRecall } from "./recall.js";
import { canonical, makeFact, memoryCodec, MemoryShapeError, scopeFor, submission, UUID, type Payload } from "./schema.js";

export interface MemoryIO { out(text: string): void; err(text: string): void; stdinBytes?(): Buffer }
export interface MemoryDeps { now?: () => number; uuid?: () => string; seam?: SnapshotSeam }
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const stdinCap = 16 * 1024;
function number(word: string): number {
  if (!DECIMAL.test(word)) throw new Error("usage");
  const value = Number(word);
  if (!Number.isSafeInteger(value)) throw new Error("usage");
  return value;
}
function grammar(argv: string[]): { verb: string; id?: string; after?: string; limit?: number;
  generation?: number; revision?: number } {
  const [verb] = argv;
  if (verb === "add" && argv.length === 3 && argv[1] === "--expected-generation") {
    return { verb, generation: number(argv[2]) };
  }
  if (verb === "show" && argv.length === 3 && argv[1] === "--id" && UUID.test(argv[2])) {
    return { verb, id: argv[2] };
  }
  if (verb === "list") {
    let after: string | undefined;
    let limit = 20;
    let index = 1;
    if (argv[index] === "--after" && UUID.test(argv[index + 1] ?? "")) {
      after = argv[index + 1];
      index += 2;
    }
    if (argv[index] === "--limit" && argv[index + 1] !== undefined) {
      limit = number(argv[index + 1]);
      index += 2;
    }
    if (index === argv.length && limit >= 1 && limit <= 20) return { verb, after, limit };
  }
  if (verb === "forget" && argv.length === 7 && argv[1] === "--id" && UUID.test(argv[2])
    && argv[3] === "--expected-revision" && argv[5] === "--expected-generation") {
    return { verb, id: argv[2], revision: number(argv[4]), generation: number(argv[6]) };
  }
  throw new Error("usage");
}
function bytes(io: MemoryIO): Buffer {
  if (io.stdinBytes) {
    const input = io.stdinBytes();
    if (input.length > stdinCap) throw new MemoryShapeError("LIMIT");
    return input;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    const part = Buffer.alloc(Math.min(4096, stdinCap + 1 - length));
    const count = readSync(0, part, 0, part.length, null);
    if (count === 0) return Buffer.concat(chunks, length);
    length += count;
    if (length > stdinCap) throw new MemoryShapeError("LIMIT");
    chunks.push(part.subarray(0, count));
  }
}
function observed(payload: Payload, context: SnapshotContext, now: number): string {
  if (!Number.isFinite(now)) throw new MemoryShapeError("INVALID");
  const at = new Date(now).toISOString();
  if (at < payload.lastObservedAt || (context.committedAt !== null && at < context.committedAt)) {
    throw new MemoryShapeError("INVALID");
  }
  return at;
}
function fixedError(error: unknown): string {
  if (error instanceof MemoryShapeError) return error.kind;
  if (error instanceof StrictJsonError) return error.code === "TOO_LARGE" ? "LIMIT" : "INVALID";
  if (error instanceof PrivateStoreError) {
    if (error.code === "TOO_LARGE") return "LIMIT";
    if (error.code === "BAD_INPUT" || error.code === "CLOCK_ROLLBACK") return "INVALID";
    if (["CONFLICT", "LOCK_HELD", "DEADLINE", "STALE"].includes(error.code)) return error.code;
  }
  return "UNAVAILABLE";
}
function finished(io: MemoryIO, verb: string, result: Awaited<ReturnType<typeof mutateSnapshot>>,
  id: string): number {
  if (result.status === "uncertain") {
    io.err(`memory ${verb}: OUTCOME_UNKNOWN\n`);
    return 3;
  }
  if (result.durability !== "synced" || !result.inventoryVerified || !result.lockReleased) {
    io.err(`memory ${verb}: WRITTEN_UNVERIFIED\n`);
    return 3;
  }
  io.out(verb === "add" ? `memory add: WRITTEN id=${id} revision=1 generation=${result.generation}\n`
    : `memory forget: DONE id=${id} generation=${result.generation}\n`);
  return 0;
}
function empty(): Payload { return { schemaVersion: 1, facts: [], tombstones: [], lastObservedAt: "1970-01-01T00:00:00.000Z" }; }
function currentTime(deps: MemoryDeps): number { return (deps.now ?? Date.now)(); }

/** Programmatic hooks are fixed by trusted callers; the CLI exposes none. */
export async function runMemoryCommand(argv: string[], io: MemoryIO, deps: MemoryDeps = {}): Promise<number> {
  const verb = argv[0];
  if (verb === "recall") {
    let options: ReturnType<typeof parseRecall>;
    try { options = parseRecall(argv); }
    catch {
      io.err("memory recall: USAGE\n");
      return 2;
    }
    try {
      const prepared = prepareRecall(options.query);
      const deadline = performance.now() + 5000;
      const binding = await bindWorkspace(process.cwd(), "memory-v1", deadline);
      const codec = memoryCodec(binding);
      const scope = scopeFor(binding);
      const result = await readSnapshot(binding, codec, deadline, (payload, context) => {
        const at = observed(payload, context, currentTime(deps));
        return projectRecall(payload, context, at, scope, prepared, options);
      }, deps.seam);
      if (result.status === "absent") {
        io.out('{"generation":0,"items":[],"omitted":0,"partial":false}\n');
        return 0;
      }
      const output = result.output.toString("utf8");
      const projected = JSON.parse(output) as { error?: string };
      if (projected.error) {
        io.err(`memory recall: REFUSED ${projected.error}\n`);
        return 1;
      }
      io.out(output);
      return 0;
    } catch (error) {
      io.err(`memory recall: REFUSED ${fixedError(error)}\n`);
      return 1;
    }
  }
  if (!["add", "show", "list", "forget"].includes(verb)) {
    io.err("memory: USAGE\n");
    return 2;
  }
  let command: ReturnType<typeof grammar>;
  try { command = grammar(argv); }
  catch {
    io.err(`memory ${verb}: USAGE\n`);
    return 2;
  }
  try {
    const input = verb === "add" ? submission(decodeStrictJson(bytes(io), { maxInputBytes: stdinCap })) : undefined;
    const deadline = performance.now() + 5000;
    const binding = await bindWorkspace(process.cwd(), "memory-v1", deadline);
    const codec = memoryCodec(binding);
    if (verb === "add") {
      const id = (deps.uuid ?? randomUUID)();
      const sourceId = (deps.uuid ?? randomUUID)();
      if (!UUID.test(id) || !UUID.test(sourceId) || id === sourceId) throw new MemoryShapeError("INVALID");
      const scope = scopeFor(binding);
      makeFact(input!, scope, id, sourceId, "2000-01-01T00:00:00.000Z");
      const result = await mutateSnapshot(binding, codec, command.generation!, deadline, (previous, context) => {
        const payload = previous ?? empty();
        const at = observed(payload, context, currentTime(deps));
        const fact = makeFact(input!, scope, id, sourceId, at);
        if (payload.facts.length + payload.tombstones.length >= 1000 || payload.facts.some((item) => item.id === id)
          || payload.tombstones.some((item) => item.id === id)
          || payload.facts.some((item) => item.sources[0].sourceId === sourceId)) throw new MemoryShapeError("INVALID");
        return { ...payload, facts: [...payload.facts, fact].sort((left, right) => left.id.localeCompare(right.id)),
          lastObservedAt: at };
      }, deps.seam);
      return finished(io, verb, result, id);
    }
    if (verb === "forget") {
      const before = await readSnapshot(binding, codec, deadline, (payload, context) => {
        observed(payload, context, currentTime(deps));
        return { found: payload.facts.some((fact) => fact.id === command.id),
          deleted: payload.tombstones.some((tomb) => tomb.id === command.id) };
      }, deps.seam);
      if (before.status === "absent") {
        io.err("memory forget: REFUSED NOT_FOUND\n");
        return 1;
      }
      const classified = JSON.parse(before.output.toString("utf8")) as { found: boolean; deleted: boolean };
      if (!classified.found) {
        io.err(`memory forget: REFUSED ${classified.deleted ? "DELETED" : "NOT_FOUND"}\n`);
        return 1;
      }
      const result = await mutateSnapshot(binding, codec, command.generation!, deadline, (previous, context) => {
        if (!previous) throw new MemoryShapeError("INVALID");
        const at = observed(previous, context, currentTime(deps));
        const fact = previous.facts.find((item) => item.id === command.id);
        if (!fact || fact.revision !== command.revision) throw new MemoryShapeError("INVALID");
        return { ...previous, facts: previous.facts.filter((item) => item.id !== command.id),
          tombstones: [...previous.tombstones, { schemaVersion: 1 as const, id: command.id!, deletedAt: at,
            sequence: context.generation + 1 }].sort((left, right) => left.id.localeCompare(right.id)), lastObservedAt: at };
      }, deps.seam);
      return finished(io, verb, result, command.id!);
    }
    const result = await readSnapshot(binding, codec, deadline, (payload, context) => {
      const at = observed(payload, context, currentTime(deps));
      if (verb === "show") {
        const fact = payload.facts.find((item) => item.id === command.id);
        if (!fact) return { error: payload.tombstones.some((item) => item.id === command.id) ? "DELETED" : "NOT_FOUND" };
        if (at >= fact.time.expiresAt) return { error: "STALE" };
        const source = fact.sources[0];
        return { assertion: display(fact.assertion), digest: fact.digest, expiresAt: fact.time.expiresAt,
          generation: context.generation, id: fact.id, polarity: fact.polarity, revision: fact.revision,
          source: { fragmentEnd: source.fragmentEnd, fragmentStart: source.fragmentStart, quote: display(source.quote),
            sha256: source.sha256, sourceId: source.sourceId }, title: display(fact.title) };
      }
      const eligible = payload.facts.filter((fact) => fact.time.expiresAt > at && (!command.after || fact.id > command.after));
      const page = eligible.slice(0, command.limit);
      return { generation: context.generation, items: page.map((fact) => ({ id: fact.id, revision: fact.revision,
        title: display(fact.title) })), nextAfter: eligible.length > page.length ? page.at(-1)!.id : null };
    }, deps.seam);
    if (result.status === "absent") {
      if (verb === "show") {
        io.err("memory show: REFUSED NOT_FOUND\n");
        return 1;
      }
      io.out('{"generation":0,"items":[],"nextAfter":null}\n');
      return 0;
    }
    const output = result.output.toString("utf8");
    const projected = JSON.parse(output) as { error?: string };
    if (projected.error) {
      io.err(`memory ${verb}: REFUSED ${projected.error}\n`);
      return 1;
    }
    if (verb === "show" && Buffer.byteLength(output) > 16 * 1024) throw new MemoryShapeError("LIMIT");
    io.out(output);
    return 0;
  } catch (error) {
    io.err(`memory ${verb}: REFUSED ${fixedError(error)}\n`);
    return 1;
  }
}
