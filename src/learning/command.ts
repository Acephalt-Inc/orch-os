// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The learning commands: `review`, `show` and `reject ID --expected-revision N`.
 *
 * Each command reads one bounded JSON document through `io.read` and writes one document or
 * view to `io.out`, or one fixed error object to `io.err`. The arguments are checked first, so
 * a usage error or a help request never reads the input. An error never repeats the input.
 */
import { type Args, type CmdSpec, HelpRequested, parse, UsageError } from "../args.js";
import { assertCurrent, reject, review } from "./propose.js";
import { canonical, DISPLAY_NOTE, type ErrorCode, LearningError, type LearningDocumentV1, MAX_BYTES, parseDocument } from "./schema.js";

export interface LearningIO {
  read(): Promise<Uint8Array | string>;
  out(s: string): void;
  err(s: string): void;
}

export interface Runtime {
  now(): Date;
}

const REVISION_FLAG = "--expected-revision";
const REVISION = /^(0|[1-9][0-9]*)$/;

const spec: CmdSpec = {
  name: "learning",
  help: DISPLAY_NOTE,
  sub: [
    { name: "review", help: "Create draft proposals." },
    { name: "show", help: DISPLAY_NOTE },
    {
      name: "reject",
      help: "Reject one exact proposal.",
      pos: [{ dest: "id" }],
      opts: [{ dest: "expected_revision", flags: [REVISION_FLAG], kind: "str", help: "Exact document revision." }],
    },
  ],
};

/** One fixed JSON object on stderr; the exit code is 2 for usage and input errors, else 1. */
function fail(io: LearningIO, code: ErrorCode): number {
  io.err(canonical({ status: "ERROR", code }) + "\n");
  return code === "USAGE" || code === "INVALID_INPUT" ? 2 : 1;
}

/**
 * Parse the arguments. The revision option must appear exactly once for `reject` and not at
 * all for the other commands; the shared parser alone would let a repeated option through.
 */
function parseArgs(argv: string[]): Args {
  const given = argv.filter((a) => a === REVISION_FLAG || a.startsWith(`${REVISION_FLAG}=`)).length;
  if (given > 1) throw new UsageError("duplicate", "");
  const { args } = parse(spec, argv);
  const command = args._path.at(-1);
  if (command !== "reject" && given) throw new UsageError("unexpected", "");
  if (command === "reject" && given !== 1) throw new UsageError("missing", "");
  return args;
}

function expectedRevision(raw: unknown): number {
  if (typeof raw !== "string" || !REVISION.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new LearningError("INVALID_INPUT");
  }
  return Number(raw);
}

/** The lower-priority view `show` prints: drafts and omissions, not the source events. */
function draftView(doc: LearningDocumentV1): unknown {
  return {
    scope: "personal",
    status: "DRAFTS_ONLY",
    revision: doc.revision,
    drafts: doc.drafts,
    omitted_event_ids: doc.omitted_event_ids,
  };
}

function execute(args: Args, doc: LearningDocumentV1, now: Date): unknown {
  const command = args._path.at(-1);
  if (command === "review") return review(doc, now);
  if (command === "show") {
    assertCurrent(doc, now);
    return draftView(doc);
  }
  return reject(doc, args.id, expectedRevision(args.expected_revision), now);
}

function byteLength(data: Uint8Array | string): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

/** Run one command. Returns the exit code; never calls process.exit itself. */
export async function main(argv: string[], io: LearningIO, runtime: Runtime): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      io.out(e.text + "\n");
      return 0;
    }
    return fail(io, "USAGE");
  }
  try {
    const raw = await io.read();
    if (byteLength(raw) > MAX_BYTES) throw new LearningError("LIMIT");
    const doc = parseDocument(raw);
    const text = canonical(execute(args, doc, runtime.now())) + "\n";
    if (Buffer.byteLength(text) > MAX_BYTES) throw new LearningError("LIMIT");
    io.out(text);
    return 0;
  } catch (e) {
    return fail(io, e instanceof LearningError ? e.code : "INVALID_INPUT");
  }
}
