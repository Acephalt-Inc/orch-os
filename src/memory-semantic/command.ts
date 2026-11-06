// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { LIMITS, validateSemanticDirectory, type SemanticSummary } from "./format.js";

interface Output { out(text: string): void; err(text: string): void }
const shardName = /^vectors-[0-9]{4}\.f32$/;

function names(path: string): string[] {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refused");
  const directory = opendirSync(path);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push(entry.name);
      if (entries.length > LIMITS.entries) throw new Error("refused");
    }
  } finally {
    directory.closeSync();
  }
  if (!entries.includes("manifest.json") || !entries.includes("rows.jsonl")) throw new Error("refused");
  const shards = entries.filter((name) => name !== "manifest.json" && name !== "rows.jsonl").sort();
  if (shards.length < 1 || shards.length > 16) throw new Error("refused");
  for (let index = 0; index < shards.length; index++) {
    if (!shardName.test(shards[index]) ||
      shards[index] !== "vectors-" + index.toString().padStart(4, "0") + ".f32") throw new Error("refused");
  }
  return shards;
}

function file(path: string, name: string, max: number): Buffer[] {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new Error("refused");
  // Keep the listed directory path intact; lexical joining can change `link/../file`.
  const fd = openSync(path + "/" + name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) ||
      stat.size < 0 || stat.size > max) throw new Error("refused");
    const chunks: Buffer[] = [];
    let remaining = stat.size;
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) throw new Error("refused");
      chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
      remaining -= count;
    }
    if (fstatSync(fd).size !== stat.size) throw new Error("refused");
    return chunks;
  } finally {
    closeSync(fd);
  }
}

function validate(path: string): SemanticSummary {
  let end = path.length;
  for (;;) {
    while (end > 0 && path[end - 1] === "/") end--;
    if (end >= 2 && path[end - 2] === "/" && path[end - 1] === ".") {
      end -= 2;
      continue;
    }
    break;
  }
  const directory = path.slice(0, end) || "/";
  const shards = names(directory);
  const manifest = file(directory, "manifest.json", LIMITS.manifest);
  const rows = file(directory, "rows.jsonl", LIMITS.rows);
  function* shardChunks() {
    for (const name of shards) yield { name, chunks: file(directory, name, LIMITS.shard) };
  }
  return validateSemanticDirectory({ manifest, rows, shards: shardChunks() });
}

/** Fixed output on every path and input failure; no untrusted text reaches either stream. */
export function runSemanticCommand(argv: string[], io: Output): number {
  if (argv.length !== 4 || argv[0] !== "semantic" || argv[1] !== "validate" ||
    argv[2] !== "--dir" || argv[3].length === 0) {
    io.err("semantic validate: USAGE\n");
    return 2;
  }
  try {
    const result = validate(argv[3]);
    io.out("semantic validate: VALID rows=" + result.rows +
      " dimension=" + result.dimension + " shards=" + result.shards + "\n");
    return 0;
  } catch {
    io.err("semantic validate: REFUSED\n");
    return 1;
  }
}
