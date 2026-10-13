# Learning drafts

This stage is a module with its own entry file; the `orch learning` command does not exist until a later registration step.

## Commands

Build with `npx tsc -p tsconfig.json`, then run `node dist/learning/entry.js review < private-input.json`, `node dist/learning/entry.js show < private-drafts.json`, or `node dist/learning/entry.js reject ID --expected-revision 1 < private-drafts.json`.
Each command reads one document from standard input and writes only standard output and standard error; it has no output-file option and creates no file.
`review` prints the next document, with the drafts written again from the events, the settings snapshot, the rejection markers and the clock.
`show` prints the drafts and the omitted event IDs of a reviewed document, without its events.
`reject` removes one current draft, keeps its ID as a rejection marker and raises the document revision by one; `--expected-revision` must be the document's current revision.
There is no accept or apply command, no schedule and no option to set the clock.
The help text carries this sentence: "Proposed display settings and quoted notes only; current instructions take precedence; nothing has been applied."
Save personal output by shell redirection to a private location, never to a team repository or shared store.

## Document

The input, saved output, and later-command document is an object with exactly `schema_version`, `scope`, `revision`, `settings`, `events`, `rejections`, `source_digest`, `drafts`, and `omitted_event_ids`.
`schema_version` is `1`, `scope` is `personal`, and `revision` is a nonnegative safe integer.
`settings` is null or an exact object with `schema_version: 1`, a nonnegative safe-integer `revision`, and a `values` object containing only optional `response-language` (`en` or `zh`) and `answer-length` (`short` or `normal`) keys.
An active event has an identifier matching `[a-z][a-z0-9-]{0,47}`, a positive safe-integer `event_revision`, `state: "active"`, UTC millisecond `recorded_at` and `expires_at` timestamps, and a lifetime no longer than 90 days.
An active event is either a `setting-correction` with one allowed key and value or a `lesson-note` with nonempty text of at most 1,024 UTF-8 bytes.
A note may contain tab and newline; every other control character, carriage return and escape included, is refused.
A deleted event has exactly `event_id`, `event_revision`, and `state: "deleted"`.
`rejections` contains exact objects with one 64-character lowercase SHA-256 proposal `id` and no reason text.
`source_digest` is null in an initial review input and otherwise a 64-character lowercase SHA-256 digest; `show` and `reject` answer `STALE` when it is null.
`drafts` contains at most five exact DRAFT records with authority `user-supplied-unverified`, evaluation `not-run`, source event ID and revision, effect, expiry, and conflict flag.
`omitted_event_ids` lists the eligible events beyond the five-draft limit in event-ID order.
Extra keys at every level are rejected.
Input is capped at 64 KiB, 20 events before identical copies are merged, and 100 distinct rejection markers, and output is capped at 64 KiB.
Output is one line of JSON with object keys sorted at every level and no whitespace between tokens, followed by a newline; events are sorted by event ID in code-unit order, the same on every locale.

## Errors

An error is one JSON object on standard error, `{"code":"...","status":"ERROR"}`, with empty standard output; it never repeats any part of the input.
`USAGE` and `INVALID_INPUT` exit with 2; `CONFLICT`, `STALE`, `NOT_FOUND`, `LIMIT` and `TIMEOUT` exit with 1; help exits with 0.
`CONFLICT` means the same event ID appears twice with different content, or `--expected-revision` is not the document's revision.
`STALE` means the events, the snapshot or the clock no longer give the stored drafts; run `review` on the current records.
`NOT_FOUND` means the ID given to `reject` is not a current draft.
`LIMIT` means the input or the output is over a cap; nothing is cut to fit.
`TIMEOUT` means standard input did not end within 4.5 seconds; the entry then closes the input and exits.

## Personal data

The personal label does not authenticate the author or permit sharing.
Every draft is labelled `user-supplied-unverified`, and a digest detects content changes rather than identity or truth.
A lesson remains quoted text and is not executable instruction or trusted fact.
A settings snapshot is read-only interchange data: with it a setting draft carries the before value and the settings revision, and without it both are null and `before_known` is false.
Review creates drafts without applying settings, reading a file, an environment variable or the home directory, contacting a service, or launching a process.
Reject keeps only the proposal identifier and does not erase source events, shell output, unmanaged files, or host transcripts.
The output of `review` and `reject` contains the source events, notes included, so it is as private as the input.

## Limits

The fixture in `tests/fixtures/learning` has fixed dates: its events are eligible from 2026-10-12T12:00:00.000Z until 2026-11-12T12:00:00.000Z, and the tests run it on a clock frozen at 2026-10-13T12:00:00.000Z.
The input deadline has been measured on macOS only; native Windows behaviour of the direct entry is not verified.
The module guarantees inspectable draft processing, not natural-language correctness, live-store freshness, authenticated authorship, private shell-redirection enforcement, or improved future behavior.
