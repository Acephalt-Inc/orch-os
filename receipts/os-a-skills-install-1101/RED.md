# RED

`npx vitest run tests/skills-install.test.ts` collected the first guard and failed: `test_skills_install_copies_every_shipped_skill` expected exit code 0 and received 2 because `orch skills install` did not exist.

The first attempt stopped before collection because Vite could not write into the linked `node_modules`. During testing, the worktree used a local `node_modules` directory with links to the existing packages so the offline runner could create its temporary config. The original link was restored afterward.

Mutation checks used temporary edits to `src/skills.ts` and restored its original bytes after each run:

- Skipping the final shipped skill made `test_skills_install_copies_every_shipped_skill` fail: `sleep` was absent from the installed names. Restored: the focused test passed.
- Replacing an edited copy without `--force` made `test_skills_install_keeps_modified_copy` fail: the CLI printed `away: installed` instead of `away: kept (modified)`. Restored: the focused test passed.
