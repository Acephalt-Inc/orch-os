# Personal display preferences

`orch preference` is a command of the packaged `orch` program.

It stores an explicit response language or answer length for one canonical workspace under the OS user's private home directory.

These values are display settings, not approval, authorization, policy, or verified facts.

The command does not know whether a task is personal or shared: `show` returns the saved settings to any caller that runs it for that workspace.

Whether an assistant uses these settings in a shared task, and how it ranks them against current user and host instructions, is decided by the instructions given to the assistant, which are not part of this command.

Settings expire after 90 days and can be shown or removed explicitly.

No network request, transcript capture, import, export, migration, or automatic approval is performed.

No command reads standard input.

A workspace path that is a symbolic link, or that passes through one, is refused with status 4 and nothing is created.

On macOS `/tmp` and `/var` are symbolic links, so a workspace below them has to be given by its `/private/...` path.

If `.orch-private`, a folder inside it, or the saved state file is a symbolic link at the time it is checked, or the state file has a second hard link, every command for that workspace is refused with status 4.

A program that can replace a preferences folder between the last safety check and a filesystem operation is not defended against. Such a replacement can redirect that operation outside the preferences folder.

On macOS and Linux, an existing preferences folder that is not owned by the user, or that group or others can access, is refused with status 4 and is not changed; correct its owner and permissions before retrying.

On macOS and Linux, the saved state file is opened without following a symbolic link and is checked through the opened file.

An interrupted set or unset can leave a `.lock` folder behind, after which settings can still be shown but every set and unset for that workspace is refused.

When no set or unset is running, remove the `.lock` folder inside that workspace's folder under `.orch-private/preferences-v1` in your home folder by hand, then retry.

If a set or unset is written but its `.lock` folder cannot be removed afterwards, the command still reports the change and exits with status 0, prints a warning on standard error, and the next set or unset is refused until that folder is removed by hand.

If a set or unset is written but the preferences folder cannot be flushed afterwards, the command still reports the change, exits with status 0, and prints a warning on standard error telling the user to verify the saved preference before retrying.

The store is private to the operating-system user and does not defend against a program running as that user or as an administrator.

The folder checks and lock behaviour described here have not yet been tested on Windows.
