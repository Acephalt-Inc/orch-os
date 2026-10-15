# Private store admission

This developer library provides workspace binding, partition inspection and preparation,
opened-object admission and bounded byte reads. It is not a registered command.
Strict decoding and snapshot transactions require separate implementations.

Import `bindWorkspace` and `partitionPaths` from `private-store/binding.js`, and
`inspectPartition`, `preparePartition`, `openPrivateFile` and `readBounded` from
`private-store/privacy.js`. Pass one absolute monotonic deadline, made with
`performance.now() + 5_000`, through all steps; each entry refuses a deadline more
than five seconds ahead. Namespaces are `memory-v1`, `knowledge-v1` and `tasks-v1`.
`partitionPaths` returns frozen directory, state and lock paths from an authentic
binding. Binding objects are frozen and registered within one module instance.

`inspectPartition` and `preparePartition` return `{ kind: "present" }` or
`{ kind: "absent" }`. Preparation creates missing managed directories, without a
state file. Refusal or deadline expiry can leave directories created by that call.
`openPrivateFile` accepts exactly `state.json`, returning tagged absence or
`{ kind: "present", handle }`. The caller owns that admitted handle until passing
it to `readBounded`; a valid read consumes and closes it on success or refusal.
An invalid cap or already-expired budget refuses before taking handle ownership;
the caller must close it. The byte cap accepts zero through 16 MiB inclusive;
256 KiB is the recommended default. No JSON decoding occurs in this library.

```ts
const deadline = performance.now() + 5_000;
const binding = await bindWorkspace(workspace, "memory-v1", deadline);
const opened = await openPrivateFile(binding, "state.json", deadline);
if (opened.kind === "present") {
  try {
    const bytes = await readBounded(opened.handle, 256 * 1_024, deadline);
  } finally {
    await opened.handle.close();
  }
}
```

Errors have fixed codes and a fixed message, without paths or raw causes.
The optional trailing function seam is for programmatic tests; strings, environment
values and stored fields cannot supply those functions.

Inspecting a missing private partition creates no folder or state file.

A private partition is selected by trusted code from the user home, a fixed namespace and the canonical workspace path; ORCH_HOME does not select it.

Resolve the home with realpath (as src/preferences/store.ts:67 does); components above .orch-private are observed but a link there does not refuse; from .orch-private through the partition an observed link refuses.

A program that can replace a private-store folder between the last safety check and a filesystem operation is not defended against.

Such a replacement can redirect that operation outside the private-store folder.

This local store does not defend against a program running under the user's account or as an administrator.

readBounded retries a read that reports EINTR; this case is exercised only through the test seam because the platform does not deliver it for local files.

New folders are created with mode 0700 under the process umask; if a folder this call created is not observed as exactly 0700, prepare refuses it and does not change its mode.

The library checks that the private folders and state file are owned by the current user with owner-only permission bits; it does not read access-control lists, so an entry granting another user access is not detected.

The five-second budget prevents the library from starting its next I/O step after expiry; an OS operation submitted earlier may finish later, and the call returns only after it has.

The library returns results to its caller and does not print a report.

The macOS checks inspect observed ownership, permission bits and file types; they do not establish protection against folder replacement or detect each remote or cloud-synced home.

The Linux checks refuse identified remote home filesystems; unidentified remote and cloud-synced homes have not been verified.

Windows private-store access is unavailable in this version because its native privacy adapter has not been verified.

Linux refuses the four recognized remote-home filesystem identifiers before
creation: `0x6969`, `0x517b`, `0xff534d42`, `0x65735546`. These are a bounded list.
No native remote mount or second-user ACL verification is claimed here.

## Bounded snapshots

Import `readSnapshot`, `commitSnapshot`, `mutateSnapshot` and `recoverSnapshot` from
`private-store/snapshot.js`. The importing code supplies a fixed codec that checks
the complete payload shape. Reads return bounded serialized output from a trusted
projector; mutations run a trusted reducer under the partition lock.

A missing snapshot has generation zero; a committed change installs one complete bounded snapshot with the next generation.

Corrupt committed state is refused rather than replaced with empty state or an old temporary snapshot.

Snapshot reads and writes cooperate through one partition lock; a held lock is reported without automatic takeover.

A snapshot is limited to 16 MiB, and managed state plus temporary files to 32 MiB.

An interrupted process can leave a lock or temporary file that blocks access until explicit recovery.

Before manually removing an interrupted lock, establish that no cooperating operation is active; recovery does not establish that from its age or PID.

After a successful rename, a directory-flush or lock-cleanup failure is reported as a written change with warnings.

durability:"synced" means fsync calls on the file and its folder returned without error.

An uncertain rename outcome needs inspection before retry; it is not a request to repeat the mutation.

The operation budget stops the next I/O step after expiry, but an OS operation already submitted may complete later, and the call returns only after it has.

If a caller's output pipe fails, already delivered bytes may remain with the reader and an installed snapshot may already have changed.

The macOS snapshot tests cover process interruption on the tested local filesystem; power-loss survival has not been established.

The Linux snapshot tests cover the tested local filesystem; behaviour on unidentified remote or cloud-synced homes and power-loss survival has not been established.

Windows snapshot storage is unavailable pending a verified native privacy adapter; its rename, locking and crash behaviour has not been verified by this card.
