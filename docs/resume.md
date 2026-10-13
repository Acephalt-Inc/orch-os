# Private continuation notes

`orch resume` is a command of the packaged `orch` program.

`orch resume save --workspace PATH --expected-revision N` reads one JSON note from standard input.

Standard input has to be closed promptly: a save that has not received its whole note within two seconds saves nothing and exits with status 2.

The note contains only `objective`, `next_step`, and `reported_progress` text fields.

`orch resume show --workspace PATH` labels saved text as unverified caller text.

`orch resume forget --workspace PATH --expected-revision N` removes the note body and retains its revision marker.

Notes are stored under the operating-system user's home in `.orch-private/resume-v1` and are not covered by the legacy backup flow.

A workspace path that is a symbolic link, or that passes through one, is refused with status 4 and nothing is created.

On macOS `/tmp` and `/var` are symbolic links, so a workspace below them has to be given by its `/private/...` path.

If `.orch-private`, a folder inside it, or the saved record is a symbolic link at the time it is checked, or the record has a second hard link, every command for that workspace is refused with status 4.

A program that can replace a note storage folder between the last safety check and a filesystem operation is not defended against. Such a replacement can redirect that operation outside the note storage folder.

On macOS and Linux, an existing note storage folder that is not owned by the user, or that group or others can access, is refused with status 4 and is not changed; correct its owner and permissions before retrying.

On macOS and Linux, the saved record is opened without following a symbolic link and is checked through the opened file.

The store is private to the operating-system user and does not defend against a program running as that user or as an administrator.

The feature does not execute tasks, inspect source files, verify progress, confer authority, or resume work automatically.

Forgetting a note does not erase external copies, filesystem snapshots, or host transcripts.

An interrupted save or forget can leave a `write.lock` folder behind, after which the note can still be shown but every save and forget for that workspace is refused.

When no save or forget is running, remove the `write.lock` folder inside that workspace's folder under `.orch-private/resume-v1` in your home folder by hand, then retry.

If a save or forget is written but its `write.lock` folder cannot be removed afterwards, the command still reports the write and exits with status 0, prints a warning on standard error, and the next save or forget is refused until that folder is removed by hand.

If a save or forget is written but the note storage folder cannot be flushed afterwards, the command still reports the write, exits with status 0, and prints a warning on standard error telling the user to verify the saved note before retrying.

The input time limit, the link checks and the lock behaviour described here have been tested on macOS; they have not yet been tested on Windows.
