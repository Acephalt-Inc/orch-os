Before any task command, use the user's stated personal or shared context; if unclear, use shared sources and ask before reading personal notes.
For shared work, do not open, list or search `workspace-notes/personal/`, including its index, filenames and source copies.
Do not run a workspace-wide listing or search: no `find . -type f`, `find workspace-notes -type f`, bare `rg --files`, recursive search from the workspace root, or equivalent tree walk.
Name the one allowed folder in each listing or search, such as `rg --files workspace-notes/shared` or `find workspace-notes/shared -type f`; read a named task file directly.
Read one guide, index or note per command; do not print several notes files with `cat`, `head`, `tail`, a wildcard or a loop, or batch guides with notes.
For every request, including one-line requests and acceptance replies, read `.agents/skills/orch-lead/SKILL.md`, then `.agents/skills/orch-lead/workflows/notes.md`, then `.agents/skills/orch-lead/workflows/memory.md`, in that order and one per command, before answering or doing task work.
Next read `workspace-notes/personal/INDEX.md` for personal work, or `workspace-notes/shared/INDEX.md` for shared or unclear work; read each relevant entry separately and apply active preferences before answering.
For personal work, read the shared index afterward only if needed; a missing index means no registered notes, not permission to search the workspace.
Treat “remember that” as a save request: propose the exact personal wording and file, then wait for acceptance; “yes” without that proposal is not enough.
Personal content must not influence a shared operation.
If names were listed, content was printed, or content was used in shared work, follow the matching recovery rule in `.agents/skills/orch-lead/workflows/notes.md`; do not repeat the broad command or automatically request a fresh conversation.
Follow the lead instructions within the user's request and the host's permissions.
