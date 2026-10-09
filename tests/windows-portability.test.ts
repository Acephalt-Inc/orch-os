// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// Windows behaviour. Tests that pass `"win32"` select the Windows rules and run on every system;
// `it.runIf(process.platform === "win32")` tests need a real Windows machine (cmd.exe, .cmd files).
import { spawn, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main, WINDOWS_WORKERS_UNAVAILABLE } from "../src/cli.js";
import * as C from "../src/config.js";
import * as D from "../src/detect.js";
import { HANDBOOK, writeHandbook } from "../src/handbook.js";
import { FileLock } from "../src/lock.js";
import * as M from "../src/mergegate.js";
import { atomicWrite, cmdExe, cmdInvocation, isFullyQualifiedWindowsPath, quoteCmdArg, renameRetry, runResolved, which } from "../src/util.js";
import { fakeBin, fakeNodeBin, keepEnv, ROOT, run, testPath, tmp, useTmpHome } from "./_helpers.js";

const ON_WINDOWS = process.platform === "win32";
const HEAD = "4f2c9a1e7b3d5c8a9e0f1b2c3d4e5f6a7b8c9d0e";

/** Run `fn` with `dir` as the current directory. */
function inDir<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

// Frozen POSIX lookup/discovery rules from 52accd3, independent of production helpers.
function baseExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

function baseWhich(cmd: string | undefined | null, envPath?: string): string | null {
  if (!cmd) return null;
  if (cmd.includes("/")) return baseExecutable(cmd) ? cmd : null;
  for (const d of (envPath ?? process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const p = join(d, cmd);
    if (baseExecutable(p)) return p;
  }
  return null;
}

function baseSearchDirs(): string[] {
  const raw = process.env.ORCH_AGENT_DIRS;
  const dirs = raw === undefined ? ["~/.local/bin", "~/.claude/local", "/opt/homebrew/bin", "/usr/local/bin"]
    : raw.split(":").filter((d) => d);
  return dirs.map((d) => {
    let s = d.replace(/\$(\w+)|\$\{([^}]+)\}/g, (m, a, b) => process.env[a ?? b] ?? m);
    if (s === "~" || s.startsWith("~/")) s = (process.env.HOME || userInfo().homedir) + s.slice(1);
    return s;
  });
}

function baseFind(binary: string): [string | null, boolean] {
  const p = baseWhich(binary);
  if (p) return [resolve(p), true];
  for (const d of baseSearchDirs()) {
    const c = d.replace(/\/+$/, "") + "/" + binary;
    if (baseExecutable(c)) return [resolve(c), false];
  }
  return [null, false];
}

describe("POSIX base behaviour", () => {
  keepEnv(["PATH", "ORCH_HOME", "ORCH_AGENT_DIRS", "ORCH_POSIX_DIR", "ORCH_POSIX_EMPTY"]);

  it.skipIf(process.platform === "win32")("POSIX lookup equals the base over generated inputs", () => {
    const alphabet = ["a", "\\", ".", ":", ";", " ", '"'];
    const leaves = alphabet.flatMap(a => alphabet.flatMap(b =>
      ["", ".cmd", ".js"].map(suffix => `p${a}${b}q${suffix}`)));
    type Kind = "missing" | "exec" | "noexec" | "directory";
    const layouts: Kind[][] = [
      ["missing", "missing", "missing"], ["missing", "exec", "exec"],
      ["exec", "exec", "exec"], ["directory", "noexec", "exec"],
      ["missing", "directory", "exec"],
    ];
    for (const kinds of layouts) {
      const root = tmp();
      try {
        const locations = [root, join(root, "one"), join(root, "two")];
        for (const [i, dir] of locations.entries()) {
          mkdirSync(join(dir, "sub"), { recursive: true });
          for (const name of leaves) for (const prefix of ["", "sub"]) {
            const p = join(dir, prefix, name);
            if (kinds[i] === "directory") mkdirSync(p);
            else if (kinds[i] !== "missing") {
              writeFileSync(p, "fixture\n");
              chmodSync(p, kinds[i] === "exec" ? 0o755 : 0o644);
            }
          }
        }
        inDir(root, () => {
          const entries = ["", ".", "one", locations[1], locations[2], `"${locations[1]}"`, "missing", "one;two"];
          const paths: (string | undefined)[] = [undefined, "", ...entries.flatMap(a => entries.map(b => `${a}:${b}`))];
          const names: (string | undefined | null)[] = [undefined, null, "",
            ...leaves.flatMap(n => [n, `./${n}`, `sub/${n}`, join(locations[1], n)])];
          process.env.PATH = `${locations[1]}:${locations[2]}`;
          for (const platform of ["linux", "darwin"] as const)
            for (const cmd of names) for (const envPath of paths) {
              expect(which(cmd, envPath, platform, ".CMD;.JS"),
                JSON.stringify({ kinds, platform, cmd, envPath })).toBe(baseWhich(cmd, envPath));
            }
          delete process.env.PATH;
          expect(which("absent", undefined, "linux")).toBe(baseWhich("absent"));
        });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 120_000);

  it.skipIf(process.platform === "win32")("POSIX fallback discovery equals the base over expanded and traversed paths", () => {
    const root = tmp();
    const names = [...D.KNOWN.map(([, binary]) => binary), ...["a", "\\", "."].map(c => `p${c}q`), "sub/tool", "/sub/tool"];
    const dirs = ["a:b", "plain", "else", "else/deep", "noexec", "directory"];
    try {
      for (const d of dirs) {
        const dir = join(root, d);
        mkdirSync(join(dir, "sub"), { recursive: true });
        for (const name of names) {
          const p = `${dir}/${name}`;
          if (d === "directory") mkdirSync(p, { recursive: true });
          else { writeFileSync(p, "fixture\n"); chmodSync(p, d === "noexec" ? 0o644 : 0o755); }
        }
      }
      writeFileSync(join(root, "codex"), "fixture\n", { mode: 0o755 });
      symlinkSync(join(root, "else", "deep"), join(root, "link"));
      process.env.ORCH_POSIX_EMPTY = "";
      inDir(root, () => {
        const expanded = [join(root, "a:b"), "", "plain", `${root}/plain///`, `${root}/link/..`,
          `${root}/missing/..`, join(root, "noexec"), join(root, "directory")];
        for (const dir of expanded) {
          process.env.ORCH_POSIX_DIR = dir;
          const rawEntries = ["$ORCH_POSIX_DIR", "${ORCH_POSIX_DIR}", "$ORCH_POSIX_EMPTY", `~/missing-${root.split("/").at(-1)}`, dir];
          for (const raw of rawEntries) for (const path of ["", join(root, "plain"), "plain", join(root, "noexec")]) {
            process.env.ORCH_AGENT_DIRS = raw;
            process.env.PATH = path;
            for (const platform of ["linux", "darwin"] as const) {
              expect(D.searchDirs(platform), JSON.stringify({ dir, raw, platform })).toEqual(baseSearchDirs());
              for (const binary of names) expect(D.find(binary, platform),
                JSON.stringify({ dir, raw, path, binary, platform })).toEqual(baseFind(binary));
            }
          }
        }
        delete process.env.ORCH_AGENT_DIRS;
        expect(D.searchDirs()).toEqual(baseSearchDirs());
        process.env.PATH = "";
        process.env.ORCH_AGENT_DIRS = "$ORCH_POSIX_DIR";
        process.env.ORCH_POSIX_DIR = `${root}/link/..`;
        chmodSync(join(root, "codex"), 0o644);
        expect(D.find("codex")).toEqual([resolve(`${root}/link/../codex`), false]);
        chmodSync(join(root, "codex"), 0o755);
        process.env.ORCH_POSIX_DIR = `${root}/missing/..`;
        expect(D.find("codex")).toEqual([null, false]);
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("POSIX handbook preserves template bytes for both layouts and force modes", () => {
    const source = tmp();
    const target = tmp();
    const contents = ["text", "\n", "\r", "\r\n"].flatMap(a => ["text", "\n", "\r", "\r\n"].map(b => a + b));
    try {
      for (const text of contents) for (const layout of ["flat", "skills"] as const) {
        for (const name of HANDBOOK) writeFileSync(join(source, `${name}.md`), text);
        const files = HANDBOOK.map(name => layout === "flat" ? `${target}/${name}.md` : `${target}/${name}/SKILL.md`);
        for (const file of files) rmSync(file, { force: true });
        const first = writeHandbook(target, layout, false, `${source}${sep}`);
        expect(first).toEqual(files.map(file => ({ file, action: "wrote" })));
        for (const file of files) expect(readFileSync(file)).toEqual(Buffer.from(text));
        for (const file of files) writeFileSync(file, "existing\r\n");
        expect(writeHandbook(target, layout, false, `${source}${sep}`)).toEqual(files.map(file => ({ file, action: "kept" })));
        for (const file of files) expect(readFileSync(file)).toEqual(Buffer.from("existing\r\n"));
        expect(writeHandbook(target, layout, true, `${source}${sep}`)).toEqual(files.map(file => ({ file, action: "wrote" })));
        for (const file of files) expect(readFileSync(file)).toEqual(Buffer.from(text));
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("POSIX load reads prior state before a sampling command changes it", async () => {
    const home = tmp();
    process.env.ORCH_HOME = home;
    const statePath = join(home, "load.json");
    const before = { tier: "NORMAL", history: [{ ts: 1, load_ratio: 0.1 }] };
    const during = { tier: "HIGH", history: [{ ts: 2, load_ratio: 1.2 }] };
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const script = `require('node:fs').writeFileSync(${JSON.stringify(statePath)}, ${JSON.stringify(JSON.stringify(during))}); console.log(71.5);`;
    const command = `${quote(process.execPath)} -e ${quote(script)}`;
    try {
      writeFileSync(join(home, "config.toml"), C.renderDefault(home).replace('temp_command = ""', `temp_command = ${JSON.stringify(command)}`));
      writeFileSync(statePath, JSON.stringify(before));
      expect(await run("load", "--read", "--json")).toEqual([0, '{"tier": "NORMAL"}\n', ""]);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(before);
      const [code, , err] = await run("load", "--json");
      expect([code, err]).toEqual([0, ""]);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.temp_c).toBe(71.5);
      expect(state.history[0]).toEqual(before.history[0]);
      expect(state.history).toHaveLength(2);
      expect(state.previous_tier).toBe("NORMAL");
      expect(state.tier).toBe("NORMAL");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("Windows portability", () => {
  keepEnv(["PATH", "ORCH_HOME", "ORCH_AGENT_DIRS", "ORCH_TEST_OUT"]);

  it("resolves PATHEXT commands without requiring a mode bit", () => {
    const dir = tmp();
    writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "plain"), "plain\n");
    expect(which("claude", dir, "win32", ".EXE;.CMD;.BAT")).toBe(join(dir, "claude.cmd"));
    expect(which("plain", dir, "win32", ".EXE;.CMD;.BAT")).toBeNull();
  });

  // a Windows file system has no execute bit to leave unset (docs/windows.md)
  it.skipIf(process.platform === "win32")("POSIX lookup still needs the execute bit", () => {
    const dir = tmp();
    writeFileSync(join(dir, "plain"), "plain\n");
    expect(which("plain", [dir, "/bin"].join(delimiter), "linux")).toBeNull();
  });

  it("lookup accepts only program files on Windows, whatever PATHEXT lists", () => {
    const dir = tmp();
    const scripts = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
    for (const name of ["tool.js", "tool.vbs", "tool.wsf", "tool"]) writeFileSync(join(dir, name), "x");
    expect(which("tool", dir, "win32", scripts)).toBeNull();
    // a name that already carries a script extension is not a program either
    expect(which("tool.js", dir, "win32", scripts)).toBeNull();
    writeFileSync(join(dir, "tool.cmd"), "@echo off\r\n");
    expect(which("tool", dir, "win32", scripts)).toBe(join(dir, "tool.cmd"));
    expect(which("tool.cmd", dir, "win32", scripts)).toBe(join(dir, "tool.cmd"));
    // PATHEXT still gives the order among the four program types
    writeFileSync(join(dir, "tool.exe"), "x");
    expect(which("tool", dir, "win32", ".CMD;.EXE")).toBe(join(dir, "tool.cmd"));
    expect(which("tool", dir, "win32", ".EXE;.CMD")).toBe(join(dir, "tool.exe"));
    // a PATHEXT with no program type at all falls back to the four
    expect(which("tool", dir, "win32", ".JS;.PS1")).toBe(join(dir, "tool.exe"));
  });

  it("Windows lookup never takes a program from a relative PATH entry; POSIX lookup is unchanged", () => {
    const dir = tmp();
    writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
    chmodSync(join(dir, "tool"), 0o755);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "claude.cmd"), "@echo off\r\n");
    inDir(dir, () => {
      expect(which("claude", ".", "win32")).toBeNull();
      expect(which("claude", ["", ".", "sub", ".\\sub", "./sub"].join(";"), "win32")).toBeNull();
      expect(which("claude", [".", dir].join(";"), "win32")).toBe(join(dir, "claude.cmd"));
      // a quoted entry, as cmd.exe allows in PATH
      expect(which("claude", `"${dir}"`, "win32")).toBe(join(dir, "claude.cmd"));
      // agent detection goes through the same lookup
      process.env.PATH = ".";
      process.env.ORCH_AGENT_DIRS = ["sub", "."].join(";");
      expect(D.find("claude", "win32")).toEqual([null, false]);
      // POSIX keeps what it did before: a relative entry is searched
      expect(which("tool", ".", "linux")).toBe("tool");
    });
  });

  it("tells a fully qualified Windows path from one that depends on the current drive or folder", () => {
    for (const p of ["C:\\Users\\me", "c:/tools", "\\\\server\\share\\bin", "//server/share/bin"]) expect(isFullyQualifiedWindowsPath(p), p).toBe(true);
    for (const p of ["\\usr\\local\\bin", "/usr/local/bin", "/opt/homebrew/bin", "C:tools", "C:", ".", "..\\bin", "bin", "", "\\\\server"]) {
      expect(isFullyQualifiedWindowsPath(p), p).toBe(false);
    }
  });

  it("Windows lookup accepts slash-bearing names only when fully qualified; POSIX lookup is unchanged", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "gh.cmd"), "@echo off\r\n");
      writeFileSync(join(dir, "sub", "gh.cmd"), "@echo off\r\n");
      writeFileSync(join(dir, "sub", "tool"), "#!/bin/sh\n");
      chmodSync(join(dir, "sub", "tool"), 0o755);
      inDir(dir, () => {
        for (const name of [
          "./gh", ".\\gh", "sub/gh", "sub\\gh",
          "C:sub/gh", "C:sub\\gh", "\\gh", "/gh",
        ]) {
          expect(which(name, "", "win32", ".CMD"), name).toBeNull();
        }
        expect(which("sub/tool", "", "linux")).toBe("sub/tool");
        if (ON_WINDOWS) {
          const full = join(dir, "gh");
          expect(isFullyQualifiedWindowsPath(full)).toBe(true);
          expect(which(full, "", "win32", ".CMD")).toBe(`${full}.cmd`);
        } else {
          // A POSIX absolute path is not a fully qualified Windows path.
          expect(which(join(dir, "gh"), "", "win32", ".CMD")).toBeNull();
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("rename retry policy", () => {
    it.each(["EPERM", "EACCES", "EBUSY"])(
      "retries a transient Windows %s before returning", (code) => {
        const error = Object.assign(new Error(code), { code });
        let completed = false;
        const rename = vi.fn((_from: string, _to: string) => {
          completed = true;
        }).mockImplementationOnce(() => { throw error; });
        const sleep = vi.fn();
        renameRetry("from", "to", { platform: "win32", rename, sleep });
        expect(completed).toBe(true);
        expect(rename.mock.calls).toEqual([["from", "to"], ["from", "to"]]);
        expect(sleep.mock.calls).toEqual([[2]]);
      },
    );

    it.each(["EPERM", "EACCES", "EBUSY"])(
      "bounds a persistent Windows %s and propagates its error", (code) => {
        const error = Object.assign(new Error(code), { code });
        const rename = vi.fn(() => { throw error; });
        const sleep = vi.fn();
        let caught: unknown;
        try {
          renameRetry("from", "to", { platform: "win32", rename, sleep });
        } catch (e) { caught = e; }
        expect(caught).toBe(error);
        expect(rename).toHaveBeenCalledTimes(61);
        expect(sleep.mock.calls).toEqual(
          Array.from({ length: 60 }, (_, i) => [Math.min(2 + i * 2, 40)]),
        );
      },
    );

    it.each([
      ["win32", "ENOENT"], ["win32", "EXDEV"],
      ["linux", "EPERM"], ["linux", "EACCES"], ["linux", "EBUSY"],
      ["darwin", "EPERM"], ["darwin", "EACCES"], ["darwin", "EBUSY"],
    ] as const)("does not retry %s %s", (platform, code) => {
      const error = Object.assign(new Error(code), { code });
      const rename = vi.fn(() => { throw error; });
      const sleep = vi.fn();
      let caught: unknown;
      try {
        renameRetry("from", "to", { platform, rename, sleep });
      } catch (e) { caught = e; }
      expect(caught).toBe(error);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it("the fallback agent directories on Windows are per-user, and only absolute ones are searched", () => {
    expect(D.defaultDirs("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" })).toEqual(["~/.local/bin", "~/.claude/local", "C:\\Users\\me\\AppData\\Roaming\\npm"]);
    expect(D.defaultDirs("win32", {})).toEqual(["~/.local/bin", "~/.claude/local"]);
    // no rooted path without a drive: on Windows that is a folder on the current drive
    expect(D.defaultDirs("win32", {}).filter((d) => /^[\\/]/.test(d))).toEqual([]);
    expect(D.defaultDirs("linux")).toBe(D.DEFAULT_DIRS);
    const abs = tmp();
    process.env.ORCH_AGENT_DIRS = ["relative/dir", ".", abs].join(";");
    expect(D.searchDirs("win32")).toEqual([abs]);
    // POSIX keeps every listed directory, as before
    process.env.ORCH_AGENT_DIRS = ["relative/dir", abs].join(delimiter);
    expect(D.searchDirs("linux")).toEqual(["relative/dir", abs]);
  });

  it.runIf(ON_WINDOWS)("on a Windows machine a directory without a drive is never searched for agents", () => {
    const abs = tmp();
    writeFileSync(join(abs, "claude.cmd"), "@echo off\r\n");
    process.env.PATH = join(abs, "nothing-here");
    process.env.ORCH_AGENT_DIRS = ["\\usr\\local\\bin", "/opt/homebrew/bin", "C:tools", "tools", abs].join(";");
    expect(D.searchDirs()).toEqual([abs]);
    expect(D.find("claude")).toEqual([join(abs, "claude.cmd"), false]);
    delete process.env.ORCH_AGENT_DIRS;
    for (const d of D.searchDirs()) expect(isFullyQualifiedWindowsPath(d), d).toBe(true);
  });

  it("quotes for cmd.exe with a caret before every metacharacter and builds a fixed invocation", () => {
    const value = 'a & b|c" %PATH%';
    expect(quoteCmdArg(value, 1)).toBe('^"a^ ^&^ b^|c\\^"^ ^%PATH^%^"');
    expect(quoteCmdArg("C:\\dir\\", 1)).toBe('^"C:\\dir\\\\^"');
    expect(quoteCmdArg("a b")).toBe('^^^"a^^^ b^^^"');
    const [exe, args] = cmdInvocation("C:\\Program Files\\x\\agent.cmd", ["a b"]);
    expect(isFullyQualifiedWindowsPath(exe)).toBe(true);
    expect(exe.toLowerCase().endsWith("cmd.exe")).toBe(true);
    expect(args).toEqual(["/d", "/v:off", "/s", "/c", '"C:\\Program^ Files\\x\\agent.cmd ^^^"a^^^ b^^^""']);
    // cmd.exe is named by full path, never as a bare name
    expect(cmdExe({ ComSpec: "cmd.exe", SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\cmd.exe");
    expect(cmdExe({ ComSpec: "E:\\sys\\cmd.exe" })).toBe("E:\\sys\\cmd.exe");
    expect(cmdExe({})).toBe("C:\\Windows\\System32\\cmd.exe");
    // cmd.exe ends a command at a line break: refused, not cut short
    expect(() => cmdInvocation("agent.cmd", ["one\ntwo"])).toThrow(/line break/);
    expect(() => runResolved("agent.cmd", ["one\r\ntwo"], { encoding: "utf8" }, "win32")).toThrow(/line break/);
  });

  it.runIf(ON_WINDOWS)("a .cmd program receives hostile arguments unchanged", () => {
    const dir = join(tmp(), "dir with space & (x)");
    mkdirSync(dir);
    const echo = fakeNodeBin(dir, "echoargs", "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const values = ['a & b|c" %PATH%', "%PATH%", "%%", "^caret^", "(paren) <lt> >gt", "back\\slash\\", "end\\\\", '"quoted"', 'in"ner\\"x', "semi;comma,eq=",
      "*?!bang!", "!x!", "!PATH!", "/starts-with-a-slash", "", "tab\there", "\u00e9\u4e2d\u6587", "--jq", ".sha as $s | .statuses[] | [$s, .context, .state] | @json",
      ".check_runs[] | [.head_sha, .name, (.conclusion // .status), .check_suite.id] | @json",
      "repos/o/n/actions/runs?head_sha=abc&per_page=100", "C:\\Program Files\\x y\\", "& whoami", "| more", "> out.txt"];
    const result = runResolved(echo, values, { encoding: "utf8", cwd: dir });
    expect(result.status, `${result.error ?? ""}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(values);
    expect(readdirSync(dir).sort()).toEqual(["echoargs.cmd", "echoargs.mjs"]); // nothing was redirected into a file
    // an .exe is started directly and may carry a line break
    const direct = runResolved(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "one\ntwo"], { encoding: "utf8" });
    expect(JSON.parse(direct.stdout)).toEqual(["one\ntwo"]);
  });

  it.runIf(ON_WINDOWS)("gh is started from PATH, never from the current directory", () => {
    const here = tmp();
    const bins = tmp();
    copyFileSync(process.execPath, join(here, "gh.exe"));
    fakeNodeBin(bins, "gh", 'process.stdout.write("from PATH: " + process.argv.slice(2).join(" "));\n');
    process.env.PATH = bins;
    inDir(here, () => {
      // what Windows does with a bare name: the current directory is looked in first
      const bare = spawnSync("gh", ["-e", "process.stdout.write('from the current directory')"], { encoding: "utf8" });
      expect(bare.stdout).toBe("from the current directory");
      expect(M.gh(["pr", "view", "5"])).toBe("from PATH: pr view 5");
    });
    rmSync(here, { recursive: true, force: true });
  });

  it("normalizes CRLF templates while writing the handbook", () => {
    const source = `${tmp()}${sep}`;
    const target = tmp();
    for (const name of HANDBOOK) writeFileSync(`${source}${name}.md`, `---\r\nname: ${name}\r\n---\r\n`);
    writeHandbook(target, "flat", false, source, "win32");
    for (const name of HANDBOOK) expect(readFileSync(`${target}/${name}.md`, "utf8")).not.toContain("\r");
  });

  it("doctor passes its Windows platform row and load reports unavailable signals", async () => {
    const bin = tmp();
    writeFileSync(join(bin, "git.cmd"), "@echo off\r\n");
    process.env.ORCH_HOME = tmp();
    process.env.PATH = bin;
    expect((await main(["init", "--no-handbook"], { out() {}, err() {}, stdin: () => "" }, { platform: "win32" }))).toBe(0);
    let out = "";
    const io = { out: (s: string) => { out += s; }, err() {}, stdin: () => "" };
    expect(await main(["doctor"], io, { platform: "win32" })).toBe(0);
    expect(out).toContain("PASS  windows (no process groups)");
    expect(out).toMatch(/PASS {2}git +.*git\.cmd/);
    out = "";
    expect(await main(["load"], io, { platform: "win32" })).toBe(0);
    expect(out).toContain("load_ratio=n/a swap=n/a temp=n/a");
  });

  it("doctor on Windows passes without git and does not take timeout.exe for a worker time limit", async () => {
    const bin = tmp();
    // Windows ships a timeout.exe that waits for a key press
    writeFileSync(join(bin, "timeout.exe"), "x");
    process.env.ORCH_HOME = tmp();
    process.env.PATH = bin;
    process.env.ORCH_AGENT_DIRS = "";
    let out = "";
    const io = { out: (s: string) => { out += s; }, err() {}, stdin: () => "" };
    expect(await main(["init", "--no-handbook"], io, { platform: "win32" })).toBe(0);
    out = "";
    expect(await main(["doctor"], io, { platform: "win32" }), out).toBe(0);
    expect(out).toMatch(/SKIP {2}git +absent - only worker worktrees use it, and workers are not available on Windows/);
    expect(out).toMatch(/SKIP {2}timeout \(worker time limit\) +not used - workers are not available on Windows/);
    expect(out).toContain("doctor: PASS (0 required check(s) failed)");
    // everywhere else git stays a required check
    out = "";
    expect(await main(["doctor"], io, { platform: "linux" })).toBe(1);
    expect(out).toMatch(/FAIL {2}git +not on PATH/);
  });

  it.each([["worker", "start", "w"], ["worker", "stop", "w"], ["review", "watch", "1"]])(
    "%s %s refuses before using POSIX facilities on Windows", async (...command) => {
      let err = "";
      const code = await main(command, { out() {}, err: (s) => { err += s; }, stdin: () => "" }, { platform: "win32" });
      expect(code).toBe(2);
      expect(err.trim()).toBe(WINDOWS_WORKERS_UNAVAILABLE);
    },
  );
});

/** Start a process that opens `file` for reading, says so, and closes it `ms` later. Resolves once the file is open. */
async function holdOpen(file: string, ms: number): Promise<{ closed: Promise<number | null> }> {
  const script = `const fs = require("node:fs"); const fd = fs.openSync(${JSON.stringify(file)}, "r"); process.stdout.write("open"); setTimeout(() => fs.closeSync(fd), ${ms});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = new Promise<number | null>((res) => child.once("exit", (code) => res(code)));
  await new Promise<void>((res, rej) => {
    child.stdout.once("data", () => res());
    child.once("error", rej);
    child.once("exit", () => rej(new Error("the holding process exited before it opened the file")));
  });
  return { closed };
}

// Windows refuses to rename a file, or a directory with a file in it, that another process has open.
// The state files and the lock directory are renamed while other processes read them, so those
// renames wait the reader out. These tests run everywhere; on macOS and Linux the rename never waits.
describe("Windows portability: files another process has open", () => {
  it("a lock is released while another process has its owner file open", async () => {
    const lock = join(tmp(), "held.lock.d");
    const held = new FileLock(lock);
    held.acquire();
    const reader = await holdOpen(join(lock, "owner.json"), 400);
    // for the record: what a plain rename does on this system right now
    let plain = "renamed";
    try {
      renameSync(lock, `${lock}.probe`);
      renameSync(`${lock}.probe`, lock);
    } catch (e: any) {
      plain = e.code;
    }
    console.log(`[observation] ${process.platform}: plain rename of a directory while another process has a file in it open: ${plain}`);
    held.release();
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dirname(lock))).toEqual([]); // the set-aside directory is removed as well
    expect(await reader.closed).toBe(0);
  });

  it("a state file is replaced while another process has it open", async () => {
    const file = join(tmp(), "state.json");
    writeFileSync(file, "old");
    const reader = await holdOpen(file, 400);
    let plain = "renamed";
    try {
      writeFileSync(`${file}.probe`, "old");
      renameSync(`${file}.probe`, file);
    } catch (e: any) {
      plain = e.code;
      rmSync(`${file}.probe`, { force: true });
    }
    console.log(`[observation] ${process.platform}: plain rename over a file another process has open: ${plain}`);
    atomicWrite(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(readdirSync(dirname(file))).toEqual(["state.json"]);
    expect(await reader.closed).toBe(0);
  });

  it("eight processes share one lock for 1000 updates and none of them fails", async () => {
    const dir = tmp();
    const lock = join(dir, "c.lock.d");
    const counter = join(dir, "counter");
    writeFileSync(counter, "0");
    const mod = pathToFileURL(join(ROOT, "dist", "lock.js")).href;
    const script = `import(${JSON.stringify(mod)}).then((m) => { const fs = require("node:fs");` +
      ` for (let i = 0; i < 125; i++) m.withLock(${JSON.stringify(lock)}, () => {` +
      ` const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")); fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1)); }); })`;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((res) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (chunk) => { err += String(chunk); });
      child.on("exit", (code) => res(`exit ${code} ${err}`.trim()));
    })));
    // a failing process shows its error text here
    expect(results).toEqual(Array(8).fill("exit 0"));
    expect(readFileSync(counter, "utf8")).toBe("1000");
    expect(readdirSync(dir)).toEqual(["counter"]);
  });
});

describe("Windows portability: CLI through fake programs", () => {
  const ctx = useTmpHome();
  keepEnv(["PATH", "ORCH_TEST_OUT", "ORCH_AGENT_DIRS"]);

  // the part of ReviewWatchCli > doctor_lists_review_agents_only_when_configured that does not depend on the platform row's text
  it("doctor lists a review agent row only when one is configured", async () => {
    await run("init", "--no-handbook");
    let [, out] = await run("doctor");
    expect(out).not.toContain("review agent");
    appendFileSync(join(ctx.home, "config.toml"), `\n[review.agents.r1]\ncmd = ["missing-reviewer-cli-xyz"]\n`);
    [, out] = await run("doctor");
    expect(out).toMatch(/SKIP\s+review agent r1\s+'missing-reviewer-cli-xyz' not on PATH/);
  });

  it.runIf(ON_WINDOWS)("a review comment goes through a gh.cmd; a body with a line break is refused with the reason", async () => {
    const bins = tmp("orch-gh-");
    process.env.PATH = testPath(bins);
    process.env.ORCH_TEST_OUT = join(bins, "argv.txt");
    fakeBin(bins, "gh", 'printf "%s\\n" "$@" > "$ORCH_TEST_OUT"; exit 0');
    const [code, out, err] = await run("review", "approve", "5", "--as", "r1", "--head", HEAD, "--repo", "o/n");
    expect([code, out, err]).toEqual([0, `posted on #5: ORCH-REVIEW APPROVE ${HEAD} by r1\n`, ""]);
    expect(readFileSync(process.env.ORCH_TEST_OUT!, "utf8").split("\n").slice(0, -1)).toEqual(["pr", "comment", "5", "--repo", "o/n", "--body", `ORCH-REVIEW APPROVE ${HEAD} by r1`]);
    const [code2, out2, err2] = await run("review", "changes", "5", "--as", "r1", "--head", HEAD, "--repo", "o/n", "-m", "tests missing");
    expect([code2, out2]).toEqual([1, ""]);
    expect(err2).toContain("is a .cmd or .bat file, and cmd.exe cannot pass it an argument that contains a line break");
  });
});

describe("Windows test coverage list", () => {
  it("docs/windows.md names every test that is skipped on Windows", () => {
    const doc = readFileSync(join(ROOT, "docs", "windows.md"), "utf8");
    const marker = /\b(?:describe|it)\.skipIf\(process\.platform === "win32"[^)]*\)\(\s*"([^"]+)"/g;
    const names: string[] = [];
    for (const file of readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.ts")).sort()) {
      for (const m of readFileSync(join(ROOT, "tests", file), "utf8").matchAll(marker)) names.push(`${file}: ${m[1]}`);
    }
    expect(names.length).toBeGreaterThan(0);
    for (const entry of names) {
      const [file, name] = entry.split(": ");
      expect(doc, entry).toContain(`\`tests/${file}\``);
      expect(doc, entry).toContain(`\`${name}\``);
    }
    // the number the page states is the number of markers in the test files
    expect(doc).toContain(`${names.length} \`skipIf\` markers`);
  });
});
