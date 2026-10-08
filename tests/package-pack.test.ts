// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";
import { candidate as packCandidate, pack, plantRetired, snapshot } from "./_pack.js";

const temporaryDirs: string[] = [];
const candidate = () => packCandidate(temporaryDirs);

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("pack removes retired outputs from a dirty build", () => {
  const copy = candidate();
  copy.run("npm", ["run", "build"]);
  plantRetired(copy.repo);
  const tarball = pack(copy);
  const files = copy.run("tar", ["-tzf", tarball]).trim().split("\n");
  expect(files).not.toContain("package/dist/retired.js");
  expect(files).not.toContain("package/dist/checks.js");
  expect(files).toContain("package/dist/cli.js");
  const extracted = join(copy.repo, "extracted");
  mkdirSync(extracted);
  copy.run("tar", ["-xzf", tarball, "-C", extracted]);
  const version = JSON.parse(readFileSync(join(copy.repo, "package.json"), "utf8")).version;
  expect(copy.run(process.execPath, [join(extracted, "package", "dist", "cli.js"), "--version"]).trim()).toBe(`orch ${version}`);
});

it("build removes retired outputs and tolerates missing dist", () => {
  const dirty = candidate();
  plantRetired(dirty.repo);
  dirty.run("npm", ["run", "build"]);
  expect(existsSync(join(dirty.repo, "dist", "retired.js"))).toBe(false);
  expect(existsSync(join(dirty.repo, "dist", "checks.js"))).toBe(false);
  expect(existsSync(join(dirty.repo, "dist", "cli.js"))).toBe(true);

  const fresh = candidate();
  expect(existsSync(join(fresh.repo, "dist"))).toBe(false);
  fresh.run("npm", ["run", "build"]);
  expect(existsSync(join(fresh.repo, "dist", "cli.js"))).toBe(true);
});

it("packing an isolated copy leaves checkout dist unchanged", () => {
  const before = snapshot(join(ROOT, "dist"));
  pack(candidate());
  expect(snapshot(join(ROOT, "dist"))).toEqual(before);
});
