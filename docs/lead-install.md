# Lead pack: install, status, uninstall

`orch lead` puts a pack of instruction files for a lead assistant into one workspace folder, reports what is there, and removes it again. The pack is text for the assistant to read. These commands do not check whether the assistant reads or follows it.

These commands were measured on macOS. On Windows they are unverified.

## Before you start

Use a new, empty folder as the workspace. To use both hosts, use two workspaces. The workspace path must be an existing folder, not a link.

## Install

```sh
orch lead install --workspace PATH --host claude
orch lead install --workspace PATH --host codex
```

Install creates 20 files: 19 under `.claude/skills/orch-lead` for host `claude` or `.agents/skills/orch-lead` for host `codex`, and one bootstrap file at the workspace root, `CLAUDE.md` or `AGENTS.md`. Install also creates the state directory `.orch-lead-install` with a manifest, one anchor file per installed file, a record of the directories it created and, as its last step, a record that it finished. Each installed file and its anchor are one file with two names. On macOS the installed files and the files of the state directory can be read and written by your user only.

Install first checks every path it would create. If any of them exists, install stops and creates nothing. This includes an existing `CLAUDE.md` or `AGENTS.md`, an existing pack directory and an existing `.orch-lead-install`. Install then prints every path it will create, and creates nothing until that list has been written. With `--dry-run`, install prints the list and creates nothing.

Install never changes or removes a file that already exists. If another install reserves `.orch-lead-install` first, install creates nothing and reports `CONFLICT`. If a missing parent directory appears as an ordinary directory after the check, install uses it and continues. If a file appears at one of the paths install reserves inside `.orch-lead-install` before install creates that path, install stops. Status then reports `UNVERIFIABLE_PREPARATION` if this happened before the manifest was in place, and `PARTIAL` after. A file at another name inside `.orch-lead-install` does not stop install; status lists it as an unknown entry and reports `PARTIAL`. Files created before the stop stay until you run uninstall.

## What the pack contains

The pack holds the lead skill, five role files, a task brief, a handoff form, a routing table, nine workflow guides and one sample file. Four of the guides are about notes: `workflows/notes.md`, `workflows/memory.md`, `workflows/knowledge.md` and `workflows/learning.md`. The bootstrap file and the first lines of the skill name the skill, `workflows/notes.md` and `workflows/memory.md`, in that order, as the files to read before an answer.

The guides describe notes kept in `workspace-notes/personal/` and `workspace-notes/shared/` inside the workspace, and a rule in the workspace-root `.ignore` file. Install does not create `workspace-notes/` or `.ignore`. The guides tell the assistant to ask before the first personal save and before the `.ignore` rule is added. These commands do not check that the assistant does so. Status and uninstall do not read or remove `workspace-notes/` or `.ignore`.

## Status

```sh
orch lead status --workspace PATH --host claude
```

Status reads only. It prints one state for each of the 20 paths:

| State | Meaning |
|---|---|
| `OWNED_MATCH` | the file install created, unchanged |
| `OWNED_CHANGED` | the file install created, edited in place |
| `MISSING` | nothing is at this path |
| `FOREIGN` | something else is at this path; equal content does not make it the installed file |
| `UNVERIFIABLE` | the path exists and its ownership cannot be established |

A path below a folder that was replaced by a link is `UNVERIFIABLE`. Status and uninstall do not look at anything behind that link.

It then prints one result:

| Result | Meaning |
|---|---|
| `INSTALLED` | all 20 files are `OWNED_MATCH`, install recorded that it finished, and the state directory holds nothing unexpected |
| `NOT_INSTALLED` | the workspace has no state directory |
| `PARTIAL` | the manifest is valid and something is missing, changed or foreign |
| `BUSY` | as `PARTIAL`, the install is not recorded as finished, and the process id recorded by install is in use or cannot be checked |
| `UNVERIFIABLE_PREPARATION` | a state directory exists without a manifest this version accepts |
| `CONFLICT` | printed by install only: a path already exists |

Status always ends with `host activation: unverified`.

## Uninstall

```sh
orch lead uninstall --workspace PATH --host claude
```

Uninstall removes an installed file only when it is still the file install created and its content is unchanged. A file you edited, a file that replaced an installed file and a file install did not create stay in place and are listed. Uninstall removes the state directory only when no listed path remains. With an accepted manifest and cleanup ready to finish, uninstall can remove the empty `.orch-lead-install` and `objects` directories by name without checking who created them.

When every installed file is gone, uninstall removes the directories that install created, deepest first, and only those that are empty. Apart from the two state directories, a directory that the record in `.orch-lead-install` does not list as created by install stays. A directory that holds a file install did not create stays, with every directory above it. Uninstall lists each directory it left and the reason. After an uninstall that left no pack directory, install for the same host works again. While the pack directory exists, install for that host is refused. A later uninstall has no record of a directory that an earlier one left and does not remove it. Delete it yourself.

Uninstall asks whether the process id recorded by install is in use only when the install is not recorded as finished. In that case uninstall refuses with `BUSY` while the id is in use. When that process has ended, uninstall removes the files and directories that the unfinished install recorded.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | install complete, dry run, complete uninstall, or a status of `INSTALLED` or `NOT_INSTALLED` |
| 2 | `CONFLICT`, `PARTIAL`, `BUSY` or `UNVERIFIABLE_PREPARATION` |
| 1 | wrong usage, or a file or output error; an install that stopped on a file error exits 1 even though its result line, when there is one, says `PARTIAL` or `UNVERIFIABLE_PREPARATION` |

## What these commands do not do

They read no ORCH configuration and write only below the workspace path they checked; the Limits section says what a program running as you can change. They start no other program. They make no network request.

## Limits

- A collision after the first check can leave a partial install. Status can list it. Uninstall can leave files in `.orch-lead-install` for you to inspect.
- A crash or kill while install prepares its state directory can leave files that uninstall will not remove. Status then reports `UNVERIFIABLE_PREPARATION` or `PARTIAL`. Run uninstall, read what it preserved, then delete the `.orch-lead-install` directory yourself.
- An install that was killed before it recorded its directories leaves them in place. Uninstall then removes its state and lists those directories. Delete the empty directories yourself before you install again.
- For an install that is not recorded as finished, the check on the recorded process id is a question, not a lock. If another program now has that id, uninstall reports `BUSY` until that program ends.
- A program that changes a file or a folder between a check and the next file operation is not defended against, in install, status and uninstall alike. Such a change can redirect that operation outside the workspace. Do not run two uninstalls at once.
- If a folder that install created was replaced by a link, uninstall removes nothing below it and keeps the state directory. Put the folder back, then run uninstall again.
- If a file you want to keep is at one of the pack's paths, uninstall keeps the state directory. Move that file away and run uninstall again. If you edited an installed file in place, its anchor is a second name of your edited file and uninstall keeps that too. Delete the `.orch-lead-install` directory yourself when you no longer need it.
- The manifest records the workspace path. After the workspace folder is moved or renamed, status reports `UNVERIFIABLE_PREPARATION`.
- A host can find the skill directory of a partial install on its own, before the bootstrap file exists.
- The pack is instructions for an assistant. It grants no permission, enforces no limit on workers, spending or context, and is not a working lead session.
- Use one assistant session in a workspace at a time. The pack does not stop two sessions from writing the same file.
- Windows link, junction, directory-identity and file-permission behaviour has not been measured.
- These commands do not defend against a program running as your user or as an administrator. Such a program can change the records in `.orch-lead-install`, and uninstall decides from those records what to remove. Uninstall can remove unchanged pack files and anchors, state records in the accepted byte format, and empty directories at the fixed host and state paths.

### Limits of the notes guides

These files tell the assistant how to save, find and use notes. They do not enforce privacy, acceptance, size limits, deletion or who can write a file.

Personal content must not influence a shared operation. This version gives the assistant a read order, named folders and a recovery procedure; it cannot guarantee that the assistant follows them.

The ignore rule reduces accidental discovery by tools that honor it. It does not prevent direct reads, every recursive listing, forced version-control additions or access by other software. Filenames and index text can reveal personal information too.

If personal content enters a conversation, asking the assistant to rebuild from shared sources does not remove that content or prove it had no influence. A corrected answer or note does not erase earlier conversation records or copies. Use a separately controlled environment when separation must be enforced.

A saved note may be missed in a later session. File presence is not evidence that the assistant read it. Saving a lesson does not train the model or demonstrate an improvement.

This version provides no scheduled work, automatic resumption, remote knowledge connection, upload, crash recovery, backup erasure or safe concurrent writes. It cannot grant the host permission to read or write files.

The revised text has not yet been tested with real assistants or on Windows 11. The earlier results were individual observations on one Mac in non-interactive sessions, not pass rates. A later program's ability to read these notes must be tested before it is promised.
