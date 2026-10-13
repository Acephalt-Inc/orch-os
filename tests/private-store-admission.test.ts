// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("binding_uses_canonical_workspace_and_fixed_namespace", () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "private-admission-"));
  roots.push(home);
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const child = spawnSync(process.execPath, ["tests/fixtures/private-store/admission/probe.mjs", workspace], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
  });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  // K1.02
  expect(JSON.parse(child.stdout)).toMatchObject({ kind: "bound", frozen: true });
});
