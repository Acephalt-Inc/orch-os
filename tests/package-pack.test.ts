// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function candidate() {
  const dir = mkdtempSync(join(tmpdir(), "orch-pack-"));
  temporaryDirs.push(dir);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // Copy current sources and packaged assets, never checkout dist/, .git, or .npmrc.
  const assets: string[] = pkg.files.filter((p: string) => p !== "dist/");
  for (const path of ["src", "package.json", "tsconfig.json", ...assets]) {
    cpSync(join(ROOT, path), join(repo, path), { recursive: true });
  }
  // Reuse the installed compiler and types without installing or fetching anything.
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"), "dir");
  const userconfig = join(dir, "user.npmrc");
  const globalconfig = join(dir, "global.npmrc");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
    HOME: home,
    XDG_CONFIG_HOME: home,
    NPM_CONFIG_USERCONFIG: userconfig,
    NPM_CONFIG_GLOBALCONFIG: globalconfig,
    NPM_CONFIG_CACHE: join(dir, "cache"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
  };
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
    expect(result.status, `${command} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };
  expect(run("npm", ["config", "get", "offline"]).trim()).toBe("true");
  expect(run("npm", ["config", "get", "userconfig"]).trim()).toBe(userconfig);
  expect(run("npm", ["config", "get", "globalconfig"]).trim()).toBe(globalconfig);
  expect(run("npm", ["config", "get", "cache"]).trim()).toBe(join(dir, "cache"));
  expect(run(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.HOME, process.env.XDG_CONFIG_HOME]))"])).toBe(
    JSON.stringify([home, home]),
  );
  return { repo, run };
}

function plantRetired(repo: string) {
  mkdirSync(join(repo, "dist"), { recursive: true });
  for (const name of ["retired", "checks"]) {
    expect(existsSync(join(repo, "src", `${name}.ts`))).toBe(false);
    writeFileSync(join(repo, "dist", `${name}.js`), "// retired output\n");
  }
}

function pack(copy: ReturnType<typeof candidate>) {
  copy.run("npm", ["pack", "--offline"]);
  const tarballs = readdirSync(copy.repo).filter((name) => name.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return join(copy.repo, tarballs[0]);
}

function snapshot(dir: string): [string, Buffer][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? snapshot(path).map(([name, bytes]): [string, Buffer] => [join(entry.name, name), bytes])
      : [[entry.name, readFileSync(path)] as [string, Buffer]];
  });
}

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
