#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { parse, HelpRequested, UsageError, type CmdSpec } from "../args.js";
import { pathToFileURL } from "node:url";
import { PreferenceError } from "./schema.js";
import { DIRECTORY_NOT_FLUSHED, LOCK_LEFT, setPreference, showPreferences, unsetPreference, type StoreSeam } from "./store.js";

// Fixed text: a usage diagnostic never repeats what the caller typed.
const USAGE = "invalid arguments; usage: preference set KEY VALUE --workspace PATH --expected-revision N, preference unset KEY --workspace PATH --expected-revision N, or preference show --workspace PATH";
const EXIT = { invalid: 2, conflict: 3, unavailable: 4 } as const;

/** One JSON line on standard error, then the exit code for that status. */
function refuse(status: keyof typeof EXIT, message: string): number {
  process.stderr.write(`${JSON.stringify({ status, message })}\n`);
  return EXIT[status];
}

const common = [
  { dest: "workspace", flags: ["--workspace"], kind: "str" as const, help: "workspace path", metavar: "PATH" },
  { dest: "expectedRevision", flags: ["--expected-revision"], kind: "int" as const, help: "current revision", metavar: "N" },
];
const spec: CmdSpec = { name: "preference", help: "Manage personal display preferences.", sub: [
  { name: "set", help: "Set a preference.", pos: [{ dest: "key" }, { dest: "value" }], opts: common },
  { name: "show", help: "Show preferences.", opts: [common[0]] },
  { name: "unset", help: "Remove a preference.", pos: [{ dest: "key" }], opts: common },
] };

/**
 * Run one command and return its exit status. `seam` is the store's test seam: the entry below never
 * passes one, and no argument, variable or input can express one. No command reads standard input.
 */
export async function runPreferenceCommand(argv: string[], seam?: StoreSeam): Promise<number> {
  try {
    const input = argv[0] === "preference" ? argv.slice(1) : argv;
    const { args } = parse(spec, input);
    if (!args.workspace || ((args._path.at(-1) === "set" || args._path.at(-1) === "unset") && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0))) throw new UsageError("required option is missing or invalid", "usage: preference COMMAND");
    const action = args._path.at(-1);
    if (action === "show") { process.stdout.write(`${JSON.stringify(await showPreferences(args.workspace))}\n`); return 0; }
    // The store's optional clock is never passed here: the time of a change is the store's own.
    const change = action === "set" ? await setPreference(args.workspace, args.key, args.value, args.expectedRevision, undefined, seam) : await unsetPreference(args.workspace, args.key, args.expectedRevision, undefined, seam);
    process.stdout.write(`${JSON.stringify(change.view)}\n`);
    if (!change.directoryFlushed) process.stderr.write(`${JSON.stringify({ status: "warning", message: DIRECTORY_NOT_FLUSHED })}\n`);
    // The change was written and is reported as written. A lock that could not be removed is named separately.
    if (!change.lockReleased) process.stderr.write(`${JSON.stringify({ status: "warning", message: LOCK_LEFT })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) { process.stdout.write(`${error.text}\n`); return 0; }
    if (error instanceof UsageError) return refuse("invalid", USAGE);
    if (error instanceof PreferenceError) return refuse(error.status, error.message);
    return refuse("unavailable", "preference state is unavailable");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runPreferenceCommand(process.argv.slice(2));
