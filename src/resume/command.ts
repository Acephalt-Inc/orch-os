// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse, HelpRequested, UsageError, type CmdSpec } from "../args.js";
import { MAX_INPUT_BYTES, parseNote, ResumeError } from "./schema.js";
import { LOCK_LEFT, show, write, type WriteSeam } from "./store.js";

const common = [{ dest: "workspace", flags: ["--workspace"], kind: "str" as const, help: "Workspace path", metavar: "PATH" }];
const expected = { dest: "expected_revision", flags: ["--expected-revision"], kind: "int" as const, help: "Expected current revision", metavar: "N" };
const spec: CmdSpec = { name: "resume", help: "Manage a private continuation note", sub: [
  { name: "save", help: "Save a note read from standard input", opts: [...common, expected] },
  { name: "show", help: "Show a saved note as unverified caller text", opts: common },
  { name: "forget", help: "Forget a saved note", opts: [...common, expected] },
] };

// Fixed text: a usage diagnostic never repeats what the caller typed.
const USAGE = "invalid arguments; usage: resume save|forget --workspace PATH --expected-revision N, or resume show --workspace PATH";

// A save waits at most this long for its note. With the store's two-second wait for the writer
// lock, a command still ends inside its five-second bound.
const INPUT_WAIT_MS = 2_000;
const NO_INPUT = "no complete note arrived on standard input in time; nothing was saved";

/**
 * Read standard input to its end, with a deadline and a size limit. A caller that never closes the
 * input gets a fixed refusal. The input is let go of in every case, so it cannot keep the process alive.
 */
function readInput(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.destroy();
      finish();
    };
    const timer = setTimeout(() => settle(() => reject(new ResumeError("invalid", NO_INPUT))), INPUT_WAIT_MS);
    input.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) settle(() => reject(new ResumeError("invalid", "input exceeds 4 KiB")));
      else chunks.push(chunk);
    });
    input.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
    input.on("error", () => settle(() => reject(new ResumeError("unavailable", "standard input is unavailable"))));
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UsageError(`argument --${name}: expected one argument`, `usage: resume`);
  return value;
}

/**
 * Run one command and return its exit status. `seam` is the store's test seam: the entry below never
 * passes one, and no argument, variable or input can express one.
 */
export async function main(argv = process.argv.slice(2), seam?: WriteSeam): Promise<number> {
  try {
    const { args } = parse(spec, argv);
    const action = args._path.at(-1);
    const workspace = requiredString(args.workspace, "workspace");
    if (action === "show") {
      const record = show(workspace);
      if (!record?.note) { process.stdout.write(`${JSON.stringify({ status: "absent", revision: record?.revision ?? 0 })}\n`); return 0; }
      process.stdout.write(`${JSON.stringify({ status: "unverified", id: record.id, revision: record.revision, saved_at: record.saved_at, note: record.note })}\n`);
      return 0;
    }
    const revision = args.expected_revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new UsageError("argument --expected-revision: expected a non-negative integer", "usage: resume");
    // The note is read and checked before the store is touched: a refused input creates nothing.
    const note = action === "save" ? parseNote(await readInput()) : undefined;
    const { record, lockReleased } = write(workspace, revision, note, seam);
    process.stdout.write(`${JSON.stringify({ status: action === "save" ? "saved" : "forgotten", id: record.id, revision: record.revision })}\n`);
    // The write was made and is reported as made. A lock that could not be removed is named separately.
    if (!lockReleased) process.stderr.write(`${JSON.stringify({ status: "warning", message: LOCK_LEFT })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) { process.stdout.write(`${error.text}\n`); return 0; }
    if (error instanceof UsageError) { process.stderr.write(`${JSON.stringify({ status: "invalid", message: USAGE })}\n`); return 2; }
    if (error instanceof ResumeError) { process.stderr.write(`${JSON.stringify({ status: error.status, message: error.message })}\n`); return error.status === "conflict" ? 3 : error.status === "invalid" ? 2 : 4; }
    process.stderr.write(`${JSON.stringify({ status: "unavailable", message: "resume state is unavailable" })}\n`); return 4;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
