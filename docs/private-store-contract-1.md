# Private store contract, version 1

Closed API: `bindWorkspace(workspace, namespace, budget)`, `inspectPartition(binding, budget)`, `preparePartition(binding, budget)`, `partitionPaths(binding)`, `openPrivateFile(binding, name, budget)`, `readBounded(handle, cap, budget)`, `decodeStrictJson(bytes, limits)`.

Decoder inputs are supplied bytes and trusted code's limits, not a path, environment-selected schema or executable plugin.

Bindings are opaque values registered in a module-private WeakSet at bindWorkspace and frozen with Object.freeze.
partitionPaths checks membership; a spread copy or JSON round-trip refuses BAD_BINDING (K1.03).
This brand is valid only within the same module instance.
`partitionPaths` runtime-validates that brand and returns immutable directory/state/lock paths to trusted importing code; it accepts no path suffix.

Namespace is exactly `memory-v1`, `knowledge-v1` or `tasks-v1`, chosen by trusted importing code.
Path is `<user home>/.orch-private/<namespace>/personal/<sha256(canonical workspace)>/`; no supplied suffix, collection path or store override.

Canonical workspace is an existing non-link directory; reject NUL and observed linked components before realpath.
K1.02 compares SHA-256 digests for distinct canonical paths and case aliases; this is path binding, not a permanent identity across workspace moves.
Legacy ORCH_HOME is not used.

The home is resolved with realpath (as `src/preferences/store.ts:67` does); components above `.orch-private` are observed but a link there does not refuse; from `.orch-private` through the partition an observed link refuses.
A root/system ancestor does not need the managed 0700/current-UID predicate; home/system ancestors are not chmodded.
The home environment is location input within the same-account boundary, not an authenticated account selector.

`inspectPartition` is non-creating; `preparePartition` creates missing private directories, not state.
Permissions of existing objects are not changed.
New folders are created with mode 0700 under the process umask; if a folder this call created is not observed as exactly 0700, prepare refuses it and does not change its mode.

Files use 0600; opened-object UID and permission bits, regular-file type and `nlink === 1` are inspected before reading.
Existing directories must have current UID and `(mode & 0o777) === 0o700`; existing files must have current UID and `(mode & 0o777) === 0o600`.
Observed special mode bits are rejected as well.

Final-component `O_NOFOLLOW`, directory `O_DIRECTORY`, and `O_NONBLOCK` are always used on macOS and Linux (K1.05 FIFO control); ancestor checks are observations, not containment.
`openPrivateFile` accepts exactly `state.json` in this version.
Missing returns a tagged absent result (K1.01/05); permission, read or validation errors do not become absence.

Directory creation, lock work, transaction staging and explicit recovery are distinct from canonical-state replacement.
Refusal or DEADLINE can leave objects created by this operation.
These outcomes do not imply zero disk effects.
Unsafe pre-existing objects retain their identity, mode and bytes.

On process.platform === "win32", private admission entries return PRIVACY_UNAVAILABLE before any fs call (K1.11); bindWorkspace is witnessed natively and other entries remain gated.
Private access on Windows is unavailable in this version.

Library errors contain a fixed code and fixed message with no input interpolation or raw error cause.
Admission codes: `BAD_INPUT`, `BAD_BINDING`, `UNSAFE_PATH`, `PRIVACY_UNAVAILABLE`, `TOO_LARGE`, `DEADLINE`, `IO_UNAVAILABLE`.
Decoder errors use the BAD_INPUT/TOO_LARGE fixed-code scheme.
Admission provides the shared fixed error type and reserved successor codes.
The shared fixed error type also reserves `CORRUPT_STATE`, `CONFLICT`, `STALE`, `LOCK_HELD`, `RECOVERY_REQUIRED`, `WRITE_OUTCOME_UNKNOWN`, `CLOCK_ROLLBACK` for successor consumers; it does not implement those behaviours here.
INVALID input is distinct from unavailable storage.
No raw errors are written to a stream by this library (K1.12 reporting fixture).

`budget` is trusted code's monotonic deadline, at most 5,000 ms from operation entry and shared across binding/admission/read steps rather than restarted per helper.

Decoder defaults: maximum input 256 KiB, container depth 8 (root container depth 1), array length 1,000, object keys 32, decoded string 256 KiB UTF-8.
Trusted callers may raise total input to 16 MiB, not the other defaults.
Exact cap is accepted; cap + 1 refuses.
Decoder defaults and its fixed errors stay local to `json.ts`.
The decoder adds no runtime dependency.

Bytes are counted across chunks before decoding; invalid UTF-8, malformed JSON, duplicate decoded keys including escaped equivalents, forbidden keys `__proto__`, `prototype`, `constructor`, unpaired surrogate strings (String.prototype.isWellFormed() after decoding), non-finite numbers and unsafe integral numbers are rejected.
The decoder uses fatal TextDecoder, an original bounded JSON tokenizer/parser and fresh objects; JSON.parse alone loses duplicate keys.
String.prototype.isWellFormed() checks decoded lone surrogates (K1.07).

Fractional finite numbers may pass syntax parsing; field codecs decide their domain.
Decoded objects are fresh; decoded JSON is data, not configuration.

A trusted schema codec rejects unknown fields at its supported depths and reports a fixed shape error.
The codec is trusted code, not a persisted/schema-selected plugin.
The exact-key codec is original test code; no persisted name chooses a codec.
The decoder supplies the decoder side of the later `SnapshotCodec<T>` shape, not snapshot persistence or a new plugin entry.

Product entries use no seam. On supported local macOS/Linux filesystems they use Node 22's unmodified built-ins; Windows takes the unavailable gate. Only trusted code sets the finite monotonic deadline, at most 5,000 ms after entry. Invalid arguments return the listed fixed typed error. After each completed asynchronous step the library checks the budget. Once expiry is observed, it starts no next read, stat, mkdir, write, transport call or child process. An acquired handle may receive one awaited close attempt after expiry. After that attempt settles, the result is DEADLINE, with no value or next ordinary step. A directory created by a late mkdir may remain. This is a logical step rule, not a five-second wall-clock completion bound.

Each entry accepts an optional trailing test seam only in tests, in the pattern of `src/preferences/store.ts:27–35`; it cannot be expressed from CLI input, environment or stored bytes (K1.03/12). The closed in-scope seam is a plain object with only declared function-valued keys and no accessors or Proxy. `platform`, `uid`, `clock`, `uuid` and `flags` are pure, synchronous, total and native-shaped. `clock` returns finite, nondecreasing numbers and never throws. `lstat`, `realpath`, `statfs`, `mkdir`, `open`, `read` and `FileHandle.close` return their declared native-shaped promises, settle in finite time (possibly after the deadline), and may reject an ordinary Error with an optional stable string errno `code`. `read` reports a valid count and fills that many bytes. A returned handle has native `stat` and `close` semantics. I/O hooks may advance the dedicated test clock at completion and record calls; they do not change admission decisions or unrelated state. This scope excludes hook-thrown library errors, primitives, synchronous throws from promise-returning hooks, malformed values, throwing getters and unbounded callbacks.

An OS call submitted before expiry can settle late or never settle; close can fail or never settle. No cancellation, guaranteed descriptor closure after a failed close, rollback or wall-clock return time is promised. For a finite settled operation under the stated product or closed test conditions, the result is a value or one `PrivateStoreError` with a listed code, fixed message and no raw `cause` or `path`. A caller-owned handle passed to `readBounded` remains caller-owned and usable if validation refuses before reading. Out-of-list hooks are test code outside the product contract: they may return, yield any typed error, throw raw or hang, with no code or cleanup result promised. Same-process JavaScript cannot promise no hang or uncaught throw for arbitrary executable hooks. Zero-call assertions run the built library in a child with an `--import` trace preload (pattern `tests/preferences-store.test.ts:49–55`); K1.12 adds a preload hooking `child_process`, `net`, `http`, `https`, `dns`, `worker_threads`. These hooks, together with filesystem tracing, observe the inert-input assertion.

K1.12 requires both preloads; fs-only tracing is insufficient for inert-input observations.

| Row | Setup → real entry → required observation | Witness test |
|---|---|---|
| K1.01 | Missing partition → inspect → tagged absent, with zero write-capable filesystem calls and no created entries. | `inspect_missing_is_noncreating` |
| K1.02 | Two same-basename directories, Unicode/spaces and an observed linked workspace → bind → distinct canonical-path bindings for the plain directories; linked workspace input raises BAD_BINDING before private access. Resolve a home alias through a link without refusal and verify ancestors unchanged; CaseDir/casedir give one digest on a case-insensitive volume, otherwise skip that control with the realpath-alias reason. | `binding_uses_canonical_workspace_and_fixed_namespace` |
| K1.03 | Forged binding, unknown namespace, root/owner/approval override and changed ORCH_HOME → exported entries → rejection of authority overrides; ORCH_HOME does not select or get read as storage. | `outside_values_cannot_select_store_authority` |
| K1.04 | Missing folders / pre-existing broad-mode or foreign-UID folder → prepare → umask 022 child observes 0700; umask 0277 child observes 0500 then UNSAFE_PATH, with no chmod and the folder left as created; unsafe existing folder refuses without chmod or content write. Native foreign-UID control is a root-owned system directory (uid 0), opened read-only with the real predicate; no root is needed. | `posix_directory_admission_checks_opened_object` |
| K1.05 | Existing state with broad mode, foreign UID, symlink, extra hard link, FIFO or directory → open → UNSAFE_PATH without reading content bytes. | `posix_leaf_admission_precedes_content_read` |
| K1.06 | Swap the state leaf to a symlink just before open → open → Unix final-leaf refusal and zero target-byte reads; no claim about swapped ancestors. | `posix_final_leaf_swap_is_refused` |
| K1.07 | Valid exact-cap JSON and invalid UTF-8, duplicate decoded/escaped-equivalent keys, prototype keys, lone surrogates, malformed JSON, depth/array/key/string overflow, non-finite and unsafe integral numbers → decoder → accepted boundary or designated fixed error, not TypeError. | `strict_json_closed_input_matrix` |
| K1.08 | Valid JSON `[]`, `7`, `"text"`, `null`, `true`, wrong table/row types and extra fields → strict decoder plus original exact-key codec → fixed documented shape refusal. | `codec_shapes_are_checked_after_json` |
| K1.09 | Short chunks, seam-injected EINTR and mid-read faults → readBounded → complete exact bytes, retry a seam-injected EINTR within budget (the platform does not deliver EINTR for local regular files; this case is seam-only), or fixed unavailable with no partial value. | `bounded_read_loops_and_faults` |
| K1.10 | Real blocking FIFO open with O_NONBLOCK dropped by seam, budget 150 ms, writer at 400 ms, plus delayed valid read/open completions → exported entry → DEADLINE; trace exactly one close and no other call after open resolves. Await first; do not race a timer. | `late_admission_cannot_start_next_io` |
| K1.11 | Actual Windows bindWorkspace → PRIVACY_UNAVAILABLE before any fs call. Cloud platform-seam fixture is a control only. | `windows_private_access_is_unavailable` |
| K1.12 | Admission examples and platform/boundary sentences → built library fixture and documentation check → finite entry matrix matches text, with no network/process execution from input; decoder sentences and URL/instruction/control payloads → built decoder/codec fixture → finite input matrix matches text, with no filesystem/network/process starts selected by input, observed by both preloads. | `admission_public_text_matches_entry_matrix` |

K1.04 observes the exact successful-mkdir trace and resulting inventory for each child umask.
At 0277, the result is UNSAFE_PATH, the created directory is at 0500, and there is no state file, no chmod/unlink/rmdir and no later mkdir after failed admission.
At 022, directories are admitted at 0700 and there is no state creation.

At K1.10, when mkdir completion is delayed past expiry, the result is DEADLINE, the known created path remains, and no subsequent metadata or cleanup call starts.

Test homes are created under `realpath(os.tmpdir())` because `/var` is a link on macOS.
K1.02/04 includes home-link and unchanged-ancestor controls.

Allowed fakes: platform, UUID, low-level filesystem short counts/faults and open/read flags, monotonic clock, delayed completion and UID comparison in isolated child fixtures.
Real temp files plus actual native UID checks are positive controls.
Allowed fakes: programmatic low-level seams only where relevant; decoder and codec decisions execute real code.

Tests do not mock `bindWorkspace` or privacy admission decisions to make them say safe, use env-selected production faults, or use content equality as sole evidence of zero writes.
Child processes receive an environment map instead of assigned process globals.
Decoder and codec acceptance is not mocked, production faults are not installed from environment, and process.env is not assigned.
Library rows use direct real exports; subprocess fixtures also prove compiled entry behaviour.
A fixture is not a product command.
Valid content is the positive control for rejection matrices.
Wrong-shaped valid JSON is tested separately from malformed JSON.
K1.07/08 observes actual code/message rather than an incidental TypeError.
