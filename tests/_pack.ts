// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Guarded npm pack for tests: build and pack a disposable source copy, never the developer checkout.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { ROOT } from "./_helpers.js";

export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/** A disposable copy of the candidate; `track` receives its directory so the caller removes it. */
export function candidate(track: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "orch-pack-"));
  track.push(dir);
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
  // npm must not load developer config or auth tokens.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && !/^NODE_AUTH_TOKEN$/i.test(key))),
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
  // npm in the copy resolves the isolated config, cache and home, not the developer's.
  expect(run(npmCommand, ["config", "get", "offline"]).trim()).toBe("true");
  expect(run(npmCommand, ["config", "get", "userconfig"]).trim()).toBe(userconfig);
  expect(run(npmCommand, ["config", "get", "globalconfig"]).trim()).toBe(globalconfig);
  expect(run(npmCommand, ["config", "get", "cache"]).trim()).toBe(join(dir, "cache"));
  expect(run(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.HOME, process.env.XDG_CONFIG_HOME]))"])).toBe(
    JSON.stringify([home, home]),
  );
  return { dir, repo, home, userconfig, globalconfig, env, run };
}

/** Compiled files with no source counterpart, as a previous build leaves them. */
export function plantRetired(repo: string) {
  mkdirSync(join(repo, "dist"), { recursive: true });
  for (const name of ["retired", "checks"]) {
    expect(existsSync(join(repo, "src", `${name}.ts`))).toBe(false);
    writeFileSync(join(repo, "dist", `${name}.js`), "// retired output\n");
  }
}

/** Real `npm pack --offline` (prepack builds) in the copy; `args` may only add npm flags. */
export function pack(copy: ReturnType<typeof candidate>, args: string[] = []) {
  copy.run(npmCommand, ["pack", "--offline", ...args]);
  const tarballs = readdirSync(copy.repo).filter((name) => name.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return join(copy.repo, tarballs[0]);
}

export function snapshot(dir: string): [string, Buffer][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? snapshot(path).map(([name, bytes]): [string, Buffer] => [join(entry.name, name), bytes])
      : [[entry.name, readFileSync(path)] as [string, Buffer]];
  });
}
