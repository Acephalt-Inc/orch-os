# Install or update ORCH-os for the user (instructions for the coding agent)

Follow this file when the user asks you to install or update ORCH-os, or gives you only this repository's URL. If the user is working on the ORCH-os code itself, this file does not apply.

You are a coding agent (Claude Code, Codex or similar). Users of this file are often not programmers: do every step yourself, explain nothing technical unless they ask, and only stop for something they must do with their own hands (a password, an installer window, a sign-in).

1. Follow [docs/INSTALL-WITH-AGENT.md](docs/INSTALL-WITH-AGENT.md) exactly, step by step, on macOS or Windows 11. It installs the latest published `orch-os` from npm, or updates an older install to it, and keeps an existing ORCH-os home. Use it for both cases: do not build ORCH-os from this source and do not invent other install commands. When it says to stop, stop and tell the user, in plain words, which step stopped and the exact output.
2. When it ends with `doctor: PASS`, tell the user in two or three short, plain sentences: whether this was a new install or an update, the version that `orch --version` printed, and that `orch doctor` checks it again at any time (Windows: `orch.cmd doctor`). If they want to use ORCH-os with Claude Code in a project folder next, point them to `orch setup` in [docs/setup.md](docs/setup.md).
