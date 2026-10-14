// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The lead text pack: the reviewed hashes of its 21 packaged files, the loader that reads the 20
 * a host needs into memory, and the bounded file reads and writes every `orch lead` step uses.
 *
 * Limits: the hash check accepts only the reviewed bytes, but nothing here protects against a
 * program running as the same user that swaps files while they are read. On Windows O_NOFOLLOW
 * is not available and is skipped.
 */
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import type { BigIntStats } from "node:fs";
import type { PlatformPath } from "node:path";
import { type Host, type PayloadRow, payloadRows } from "./paths.js";

export const FILE_CAP = 128 * 1024;
export const PACK_CAP = 1024 * 1024;
export const MANIFEST_CAP = 64 * 1024;
/**
 * The byte loops of file reads and writes (`readDescriptor`, `writeAll` below) and the wait for
 * each standard-output write (`emit` in cli.ts) check this budget (milliseconds, monotonic
 * clock). Other loops do not check it. A single file-system call is not interrupted.
 * When a real standard-output or standard-error write is still pending at the deadline, the
 * guard exits with code 1 without writing a diagnostic (measured on macOS; see
 * lead_stalled_output_ends_within_budget and lead_both_full_outputs_end_within_budget).
 */
export const COMMAND_BUDGET_MS = 30_000;

/** SHA-256 of each packaged file as reviewed. A text change must change this table by hand. */
export const REVIEWED_SHA256: Readonly<Record<string, string>> = {
  "templates/lead/SKILL.md": "85e2a5f8d47ffe8d0174126e6b496a8e19adca776fac1aba063d307a9ed82b87",
  "templates/lead/routing.md": "0431228857660f6e143bdcda6ad7a3280ecf21dfdc1fb0961704799921cd4489",
  "templates/lead/brief.md": "9aa59257d174f1a7c0bf8aa5e018c440f7a5868b9e93d2007308c8f513216e24",
  "templates/lead/handoff.md": "183ee785a86c99e13cf6349e961fe2d7636449bf5f371d24ec1cae36b2ffd62b",
  "templates/lead/bootstrap-claude.md": "78620ed144bacdb52983d702c4551a256169cb3157aa8a2b317078a466264496",
  "templates/lead/bootstrap-codex.md": "20d18389a5393db04673ee95096e43e7bff9ea58791d51e85e2899a9dd1eab70",
  "templates/lead/agents/reader.md": "80309b9ecde5d3f6d7790213f8596fec4d780381b31ad9e0c44d804b796e1b75",
  "templates/lead/agents/mechanical.md": "4651955f2e1f9131bfaf373ed9b4ae18271aad52a2a7c3df3139ba1197f68f62",
  "templates/lead/agents/builder.md": "736b5d085879493b3fadf2e3fb5ad6702298107c076c11765160c9a0979fb0e4",
  "templates/lead/agents/verifier.md": "aa9b98d10cc513d7bc1b7b4b4b864d505387e2267275a27c7e4d1eeccf53d242",
  "templates/lead/agents/advisor.md": "5232653ac1c31e80d7a2c842472887a7ce00f62ab9e82a9e48edb37130be355d",
  "templates/workflows/crm-review.md": "6978fdf07c83cf8ecc54b0df307b7a14f4a40573a500b724aaf5044d9722f20d",
  "templates/workflows/materials.md": "4951748bf820602585c06f4459e928a59c7469e841e402e129df92d89906e50a",
  "templates/workflows/call-review.md": "7f43620f8c4975eef0dea5db8976c3536b38dfc1925f1814cf1e690f4cb59930",
  "templates/workflows/market-research.md": "49b34071638aadf6ee50cb4a9852f7f576b3cf78b76bf7b5ae4be8e6f737a464",
  "templates/workflows/company-knowledge.md": "bb77bbebf33362013af281a71095d81a2b1878236ee6c8661b9a07a4cf0c659a",
  "templates/workflows/notes.md": "2eba8925eb784b15f3eae41c2902c54d1b5ba54a9c99744e7eb8daf79c19edc7",
  "templates/workflows/memory.md": "80170839ed41a52e7fcb953f081b484d23b1552b134d3c8e341673dfe7e298aa",
  "templates/workflows/knowledge.md": "1a05e429caee22ec4b7b7557f453bd86c1d5c919938fbdac1e1efa6aab3e4624",
  "templates/workflows/learning.md": "692235ed3265f395e970623e172af938fc27c660971e760e59dc24c721692995",
  "templates/workflows/sample-customers.csv": "89a778c53ff3441b39007b86ddd3b83b7c2940441c063fb9438b63e8cc3260a2",
};

/** The file calls `orch lead` makes. Tests pass a recording or failing implementation. */
export interface LeadFs {
  lstatSync(path: string, options: { bigint: true }): BigIntStats;
  fstatSync(fd: number, options: { bigint: true }): BigIntStats;
  openSync(path: string, flags: number, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position?: number | null): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  mkdirSync(path: string, options: { mode: number; recursive: false }): unknown;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
  readdirSync(path: string): string[];
  realpathSync: { native(path: string): string };
}

export interface LeadEnv {
  fs: LeadFs;
  path: PlatformPath;
  /** Monotonic milliseconds. */
  now(): number;
  pid: number;
  /** process.kill(pid, 0): a question about liveness; it never sends a signal that acts. */
  probe(pid: number): void;
  /** Directory that holds `templates/`. */
  packageRoot: string;
}

export const realFs: LeadFs = nodeFs as unknown as LeadFs;

export type LeadErrorKind = "usage" | "io" | "pack";

export class LeadError extends Error {
  constructor(message: string, readonly kind: LeadErrorKind, readonly code?: string) {
    super(message);
    this.name = "LeadError";
  }
}

export const BIG = { bigint: true } as const;

export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "ERROR";
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checkDeadline(env: LeadEnv, deadline: number): void {
  if (env.now() > deadline) throw new LeadError("the command ran out of time", "io", "DEADLINE");
}

const O = nodeFs.constants;
/** Read-only, never through a final symbolic link, never blocking on a pipe (where the system has these flags). */
export const READ_FLAGS = O.O_RDONLY | (O.O_NOFOLLOW ?? 0) | (O.O_NONBLOCK ?? 0);
export const CREATE_WRITE_FLAGS = O.O_WRONLY | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW ?? 0);
export const CREATE_READWRITE_FLAGS = O.O_RDWR | O.O_CREAT | O.O_EXCL | (O.O_NOFOLLOW ?? 0);

export interface FileRead {
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
}

/** All bytes of an open regular file, at most `cap`; each loop turn reads at least one byte. */
function readDescriptor(env: LeadEnv, fd: number, cap: number, deadline: number, what: string): FileRead {
  const st = env.fs.fstatSync(fd, BIG);
  if (!st.isFile()) throw new LeadError(`${what} is not a regular file`, "io", "NOT_FILE");
  if (st.size > BigInt(cap)) throw new LeadError(`${what} is larger than ${cap} bytes`, "io", "TOO_LARGE");
  const buffer = Buffer.alloc(Number(st.size) + 1);
  let total = 0;
  for (;;) {
    checkDeadline(env, deadline);
    if (total === buffer.length) throw new LeadError(`${what} grew while it was read`, "io", "CHANGED");
    const n = env.fs.readSync(fd, buffer, total, buffer.length - total, total);
    if (n === 0) break;
    if (!Number.isInteger(n) || n < 0 || n > buffer.length - total) throw new LeadError(`${what}: read returned ${n}`, "io", "BAD_READ");
    total += n;
  }
  return { bytes: Buffer.from(buffer.subarray(0, total)), dev: st.dev, ino: st.ino };
}

/**
 * Open a path read-only (not through a final symbolic link), require a regular file of at most
 * `cap` bytes and return a private copy of its bytes with the file's identity.
 * File-system errors (ENOENT, ELOOP, ...) pass through unchanged.
 */
export function readBounded(env: LeadEnv, path: string, cap: number, deadline: number, what = path): FileRead {
  const fd = env.fs.openSync(path, READ_FLAGS);
  try {
    return readDescriptor(env, fd, cap, deadline, what);
  } finally {
    env.fs.closeSync(fd);
  }
}

/** Write all bytes; a short write continues, a write of zero bytes is an error. */
function writeAll(env: LeadEnv, fd: number, bytes: Buffer, deadline: number, what: string): void {
  let done = 0;
  while (done < bytes.length) {
    checkDeadline(env, deadline);
    const n = env.fs.writeSync(fd, bytes, done, bytes.length - done);
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - done) throw new LeadError(`${what}: write returned ${n}`, "io", "BAD_WRITE");
    done += n;
  }
}

/**
 * Create a new file (never an existing one), write and sync it. With `readBack`, the same
 * descriptor is read again and must hold exactly `bytes`. EEXIST passes through unchanged.
 */
export function createExclusive(env: LeadEnv, path: string, bytes: Buffer, mode: number, deadline: number, readBack: boolean): void {
  const fd = env.fs.openSync(path, readBack ? CREATE_READWRITE_FLAGS : CREATE_WRITE_FLAGS, mode);
  try {
    writeAll(env, fd, bytes, deadline, path);
    env.fs.fsyncSync(fd);
    if (readBack) {
      const again = readDescriptor(env, fd, Math.max(bytes.length, 1), deadline, path);
      if (!again.bytes.equals(bytes)) throw new LeadError(`${path}: the bytes read back differ from the bytes written`, "io", "READBACK");
    }
  } finally {
    env.fs.closeSync(fd);
  }
}

export interface PackEntry extends PayloadRow {
  sha256: string;
  bytes: Buffer;
}

/** Hash that names one host's reviewed pack: every destination with the hash of its text. */
export function packHash(rows: readonly { dest: string; sha256: string }[]): string {
  return sha256(Buffer.from(rows.map((r) => `${r.dest}\n${r.sha256}\n`).join(""), "utf8"));
}

/** The reviewed rows of a host without reading any file: destination, anchor and expected hash. */
export function reviewedRows(host: Host): (PayloadRow & { sha256: string })[] {
  return payloadRows(host).map((row) => {
    const hash = REVIEWED_SHA256[row.source];
    if (!hash) throw new LeadError(`no reviewed hash for ${row.source}`, "pack");
    return { ...row, sha256: hash };
  });
}

/**
 * Read the 20 packaged files a host needs. Each must be a regular file of valid UTF-8 text, at
 * most 128 KiB, whose SHA-256 equals the reviewed one; the pack is at most 1 MiB. Returns one
 * entry per destination, each with its own copy of the bytes. Writes nothing.
 */
export function loadPack(host: Host, env: LeadEnv, deadline: number): PackEntry[] {
  const entries: PackEntry[] = [];
  let total = 0;
  for (const row of reviewedRows(host)) {
    const file = env.path.join(env.packageRoot, ...row.source.split("/"));
    let read: FileRead;
    try {
      read = readBounded(env, file, FILE_CAP, deadline, row.source);
    } catch (e) {
      if (e instanceof LeadError) throw new LeadError(e.message, "pack", e.code);
      throw new LeadError(`packaged file ${row.source} cannot be read (${errorCode(e)})`, "pack", errorCode(e));
    }
    total += read.bytes.length;
    if (total > PACK_CAP) throw new LeadError(`the pack is larger than ${PACK_CAP} bytes`, "pack", "TOO_LARGE");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      throw new LeadError(`packaged file ${row.source} is not UTF-8 text`, "pack", "NOT_UTF8");
    }
    if (sha256(read.bytes) !== row.sha256) throw new LeadError(`packaged file ${row.source} is not the reviewed text`, "pack", "HASH");
    entries.push({ ...row, bytes: read.bytes });
  }
  return entries;
}
