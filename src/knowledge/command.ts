// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * The `knowledge` command of the direct module entry: one fixed query against the synthetic
 * corpus. Errors are a fixed JSON line; nothing the caller typed is printed back.
 */
import { CmdSpec, HelpRequested, parse, UsageError } from "../args.js";
import { query } from "./query.js";
import { ErrorCode, QUESTION_IDS, QuestionId, Transport } from "./schema.js";

export type IO = { out(text: string): void; err(text: string): void };
export type Runtime = { transport: Transport; now(): Date };

/** UTF-8 bytes of the arguments, with one separator byte between two of them. */
const MAX_ARGV_BYTES = 512;
/** Options refused when repeated: the shared parser would let the last one win silently. */
const ONCE = ["--connection", "--question-id"];

export const spec: CmdSpec = {
  name: "knowledge",
  help: "Synthetic demo; no service connected.",
  sub: [{
    name: "query",
    help: "Synthetic demo; no service connected. Looks up one fixed question in the built-in corpus.",
    opts: [
      { dest: "connection", flags: ["--connection"], kind: "str", choices: ["demo"], help: "Synthetic connection." },
      {
        dest: "question_id", flags: ["--question-id"], kind: "str",
        choices: [...QUESTION_IDS], help: "Fixed question identifier.",
      },
    ],
  }],
};

function errorLine(code: ErrorCode): string {
  return JSON.stringify({ status: "ERROR", code }) + "\n";
}

function count(argv: string[], flag: string): number {
  return argv.filter((a) => a === flag || a.startsWith(flag + "=")).length;
}

/** The question the arguments name. Throws HelpRequested for help, UsageError otherwise. */
function questionOf(argv: string[]): QuestionId {
  if (Buffer.byteLength(argv.join("\0"), "utf8") > MAX_ARGV_BYTES) throw new UsageError("arguments too long", "");
  if (ONCE.some((flag) => count(argv, flag) > 1)) throw new UsageError("repeated option", "");
  const { args } = parse(spec, argv);
  if (args.connection === null || args.question_id === null) throw new UsageError("missing option", "");
  return args.question_id;
}

export async function main(argv: string[], io: IO, runtime: Runtime): Promise<number> {
  let questionId: QuestionId;
  try {
    questionId = questionOf(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      io.out(e.text + "\n");
      return 0;
    }
    // The parser's message quotes what was typed, so it is dropped for the fixed line.
    io.err(errorLine("USAGE"));
    return 2;
  }
  const result = await query(questionId, runtime.transport, runtime.now);
  if (result.exit === 0) io.out(result.output + "\n");
  else io.err(errorLine(result.code));
  return result.exit;
}
