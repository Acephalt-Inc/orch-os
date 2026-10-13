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

Install creates 17 files: 16 under `.claude/skills/orch-lead` for host `claude` or `.agents/skills/orch-lead` for host `codex`, and one bootstrap file at the workspace root, `CLAUDE.md` or `AGENTS.md`. Install also creates the state directory `.orch-lead-install` with a manifest and one anchor file per installed file. Each installed file and its anchor are one file with two names. On macOS the installed files, the anchors and the manifest can be read and written by your user only.

Install first checks every path it would create. If any of them exists, install stops and creates nothing. This includes an existing `CLAUDE.md` or `AGENTS.md`, an existing pack directory and an existing `.orch-lead-install`. Install then prints every path it will create, and creates nothing until that list has been written. With `--dry-run`, install prints the list and creates nothing.

Install never changes or removes a file that already exists. If another program creates one of the paths after the check, install stops at that path, leaves that file unchanged and reports `PARTIAL`. Files created before the stop stay until you run uninstall.

## Status

```sh
orch lead status --workspace PATH --host claude
```

Status reads only. It prints one state for each of the 17 paths:

| State | Meaning |
|---|---|
| `OWNED_MATCH` | the file install created, unchanged |
| `OWNED_CHANGED` | the file install created, edited in place |
| `MISSING` | nothing is at this path |
| `FOREIGN` | something else is at this path; equal content does not make it the installed file |
| `UNVERIFIABLE` | the path exists and its ownership cannot be established |

It then prints one result:

| Result | Meaning |
|---|---|
| `INSTALLED` | all 17 files are `OWNED_MATCH` and the state directory holds nothing unexpected |
| `NOT_INSTALLED` | the workspace has no state directory |
| `PARTIAL` | the manifest is valid and something is missing, changed or foreign |
| `BUSY` | as `PARTIAL`, and the process id recorded by install is in use |
| `UNVERIFIABLE_PREPARATION` | a state directory exists without a manifest this version accepts |
| `CONFLICT` | printed by install only: a path already exists |

Status always ends with `host activation: unverified`.

## Uninstall

```sh
orch lead uninstall --workspace PATH --host claude
```

Uninstall removes an installed file only when it is still the file install created and its content is unchanged. A file you edited, a file that replaced an installed file and a file install did not create stay in place and are listed. Uninstall removes the state directory only when no listed path remains. Uninstall never removes a directory outside `.orch-lead-install`.

After a complete uninstall the empty pack directory remains. Install for the same host is refused until you delete that empty directory yourself.

Uninstall refuses with `BUSY` while the process id recorded by install is in use.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | install complete, dry run, complete uninstall, or a status of `INSTALLED` or `NOT_INSTALLED` |
| 2 | `CONFLICT`, `PARTIAL`, `BUSY` or `UNVERIFIABLE_PREPARATION` |
| 1 | wrong usage, or a file or output error |

## What these commands do not do

They read no ORCH configuration and write nothing outside the workspace. They start no other program. They make no network request.

## Limits

- A collision after the first check can leave a partial install. Status lists it and uninstall removes the files install created.
- A crash or kill while install prepares its state directory can leave files that uninstall will not remove. Status then reports `UNVERIFIABLE_PREPARATION` or `PARTIAL`. Run uninstall, read what it preserved, then delete the `.orch-lead-install` directory yourself.
- The check on the recorded process id is a question, not a lock. If another program now has that id, uninstall reports `BUSY` until that program ends.
- A program that changes a file between the last check and the removal is not defended against. Do not run two uninstalls at once.
- If a file you want to keep is at one of the pack's paths, uninstall keeps the state directory. Move that file away and run uninstall again. If you edited an installed file in place, its anchor is a second name of your edited file and uninstall keeps that too. Delete the `.orch-lead-install` directory yourself when you no longer need it.
- The manifest records the workspace path. After the workspace folder is moved or renamed, status reports `UNVERIFIABLE_PREPARATION`.
- A host can find the skill directory of a partial install on its own, before the bootstrap file exists.
- The pack is instructions for an assistant. It grants no permission, enforces no limit on workers, spending or context, and is not a working lead session.
- Windows link, junction and file-permission behaviour has not been measured.
