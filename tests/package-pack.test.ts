// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";
import { candidate as packCandidate, npmCommand, pack, plantRetired, snapshot } from "./_pack.js";

const temporaryDirs: string[] = [];
const candidate = () => packCandidate(temporaryDirs);

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("pack removes retired outputs from a dirty build", () => {
  const copy = candidate();
  copy.run(npmCommand, ["run", "build"]);
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
  dirty.run(npmCommand, ["run", "build"]);
  expect(existsSync(join(dirty.repo, "dist", "retired.js"))).toBe(false);
  expect(existsSync(join(dirty.repo, "dist", "checks.js"))).toBe(false);
  expect(existsSync(join(dirty.repo, "dist", "cli.js"))).toBe(true);

  const fresh = candidate();
  expect(existsSync(join(fresh.repo, "dist"))).toBe(false);
  fresh.run(npmCommand, ["run", "build"]);
  expect(existsSync(join(fresh.repo, "dist", "cli.js"))).toBe(true);
});

it("packing an isolated copy leaves checkout dist unchanged", () => {
  const before = snapshot(join(ROOT, "dist"));
  pack(candidate());
  expect(snapshot(join(ROOT, "dist"))).toEqual(before);
});

/** The shell text of the `Publish` step of the release workflow, as the runner would receive it. */
function publishScript(): string {
  const lines = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Publish");
  const run = lines.findIndex((line, i) => i > step && line.trim() === "run: |");
  expect([step >= 0, run === step + 1], "release.yml: a Publish step whose next line is `run: |`").toEqual([true, true]);
  const indent = lines[run].indexOf("run:") + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// the release job runs on Linux only; the step is a bash script and is run here with stand-ins for node and npm
it.skipIf(process.platform === "win32")("the publish step keeps a pre-release off the latest tag and stops when the version is unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-step-"));
  temporaryDirs.push(dir);
  const log = join(dir, "npm.log");
  // `node` prints what the case names and exits as told; `npm` only records its arguments
  writeFileSync(join(dir, "node"), '#!/bin/sh\nprintf \'%b\' "$STUB_OUT"\nexit "$STUB_EXIT"\n');
  writeFileSync(join(dir, "npm"), '#!/bin/sh\necho "$*" >> "$STUB_LOG"\n');
  for (const name of ["node", "npm"]) chmodSync(join(dir, name), 0o755);
  const script = publishScript();
  const cases: [string, string, number, boolean, string[]][] = [
    ["a pre-release version", "2.2.0-rc.1\\n", 0, true, ["publish --access public --tag next"]],
    ["a release version", "2.2.0\\n", 0, true, ["publish --access public"]],
    ["nothing printed", "", 0, false, []],
    ["only line ends printed", "\\n\\n", 0, false, []],
    ["a missing version field", "undefined\\n", 0, false, []],
    ["a version with build text", "2.2.0+build.7\\n", 0, false, []],
    ["the version read fails", "", 3, false, []],
    ["the version read fails after printing a pre-release", "2.2.0-rc.1\\n", 3, false, []],
  ];
  for (const [label, out, exit, ok, published] of cases) {
    rmSync(log, { force: true });
    // the runner starts a `run:` step on Linux with `bash -e`
    const r = spawnSync("bash", ["-e", "-c", script], {
      encoding: "utf8", timeout: 20_000, env: { PATH: `${dir}:/usr/bin:/bin`, STUB_OUT: out, STUB_EXIT: String(exit), STUB_LOG: log },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    expect([r.status === 0, calls], `${label}: step succeeded, npm calls\n${r.stderr}`).toEqual([ok, published]);
  }
});
