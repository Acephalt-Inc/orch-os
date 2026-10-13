// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch lead` command line: help and usage before any file access, the exit codes, and the text
// checks on Windows-style workspace paths.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runLead } from "../src/lead/cli.js";
import { DIST_CLI, ROOT, WINDOWS } from "./_helpers.js";

const RUN = !WINDOWS || process.env.ORCH_LEAD_UNMEASURED === "1";
const FROZEN = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "lead-reviewed-text.json"), "utf8"));
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "orch-lead-c-")));
  scratch.push(base);
  const w = join(base, "work space");
  mkdirSync(w);
  return w;
}
/** File calls that only record what was asked and answer "no such file". */
function recordingFs() {
  const calls: [string, string][] = [];
  const refuse = (name: string) => (target: unknown) => {
    calls.push([name, String(target)]);
    throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
  };
  const names = ["lstatSync", "fstatSync", "openSync", "readSync", "writeSync", "fsyncSync", "closeSync", "mkdirSync", "linkSync", "unlinkSync", "rmdirSync", "readdirSync"];
  return { calls, fs: { ...Object.fromEntries(names.map((name) => [name, refuse(name)])), realpathSync: { native: refuse("realpathSync.native") } } };
}
async function inProcess(args: string[], deps: Record<string, unknown> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(args, { out: (s) => (out += s), err: (s) => (err += s), stdin: () => "" }, { lead: deps } as never);
  return { code, out, err };
}
const resultOf = (stdout: string) => /^result: (\w+)$/m.exec(stdout)?.[1] ?? "";

describe("orch lead: command line", () => {
  it("lead_output_wait_is_bounded", async () => {
    const w = workspace();
    const never = (_bytes: Buffer, _done: (error?: Error | null) => void) => {};
    const expired = (() => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return 0;
        }
        return 31_000;
      };
    });
    const withinOneSecond = async (promise: Promise<number>) => Promise.race([
      promise,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 1_000)),
    ]);
    expect.soft(await withinOneSecond(runLead(["--help"], { write: never, now: expired() })), "[output-wait-bounded] help returns 1 when its output wait reaches the deadline").toBe(1);
    expect.soft(await withinOneSecond(runLead(["install", "--workspace", w, "--host", "claude"], { write: never, now: expired() })),
      "[output-wait-bounded] install returns 1 when its output wait reaches the deadline").toBe(1);
    expect.soft(readdirSync(w), "[output-wait-bounded] install creates nothing before the plan output completes").toEqual([]);
  });

  it("lead_help_and_usage_come_before_any_file_access", async () => {
    const top = await inProcess(["--help"]);
    expect.soft(top.out, "orch --help lists the command").toMatch(/^ {2}lead\s+lead text pack in one workspace/m);
    const rec = recordingFs();
    const help = await inProcess(["lead", "--help"], { fs: rec.fs });
    expect.soft(help.code).toBe(0);
    for (const name of ["install", "status", "uninstall"]) expect.soft(help.out, `help lists ${name}`).toMatch(new RegExp(`^ {2}${name}\\s`, "m"));
    const installHelp = await inProcess(["lead", "install", "--help"], { fs: rec.fs });
    expect.soft([installHelp.code, installHelp.out.includes("--workspace PATH"), installHelp.out.includes("--host claude|codex"), installHelp.out.includes("--dry-run")], installHelp.out).toEqual([0, true, true, true]);
    const wrong: [string[], RegExp][] = [
      [["lead"], /usage: orch lead/],
      [["lead", "install"], /the following arguments are required: --workspace, --host/],
      [["lead", "status", "--workspace", "somewhere"], /the following arguments are required: --host/],
      [["lead", "uninstall", "--host", "claude"], /the following arguments are required: --workspace/],
      [["lead", "install", "--workspace", "somewhere", "--host", "other"], /invalid choice/],
      [["lead", "install", "--workspace", "somewhere", "--host", "claude", "--force"], /unrecognized arguments: --force/],
      [["lead", "upgrade", "--workspace", "somewhere", "--host", "claude"], /invalid choice/],
      [["lead", "status", "--workspace", "somewhere", "--host", "claude", "--dry-run"], /unrecognized arguments: --dry-run/],
      [["lead", "install", "--workspace", "", "--host", "claude"], /the path is empty/],
    ];
    for (const [argv, message] of wrong) {
      const r = await inProcess(argv, { fs: rec.fs });
      expect.soft([r.code, message.test(r.err), r.out], `${argv.join(" ")}\n${r.err}`).toEqual([1, true, ""]);
    }
    expect.soft(rec.calls, "[parse-before-io] help and wrong usage make no file call").toEqual([]);
  });

  // The path rules for Windows, run with Node's own win32 path functions on any system.
  // This is path algebra on text. It is not native Windows proof: no Windows file system is involved.
  it("lead_win32_roots_and_names", async () => {
    const refused: [string, RegExp][] = [
      ["\\\\server\\share\\work", /UNC/], ["//server/share/work", /UNC/], ["\\\\?\\C:\\work", /UNC|device/], ["\\\\.\\C:\\work", /UNC|device/],
      ["\\\\?\\UNC\\server\\share\\work", /UNC/], ["C:work", /ambiguous/], ["C:", /ambiguous/], ["\\work", /no drive letter/], ["/work", /no drive letter/],
      ["C:\\work\\notes.txt:stream", /colon/], ["C:\\work:alt\\x", /colon/], ["C:\\work\\name.", /dot or a space/], ["C:\\work\\name ", /dot or a space/],
      ["C:\\work.\\inner", /dot or a space/], ["C:\\work\\CON", /reserved/], ["C:\\work\\nul.txt", /reserved/], ["C:\\work\\COM1\\x", /reserved/], ["C:\\work\\lpt9", /reserved/],
      ["C:\\work\\a<b", /does not allow/], ["C:\\work\\a|b", /does not allow/], ["C:\\work\\a?b", /does not allow/], ["C:\\work\\a*b", /does not allow/], ["C:\\work\\a\"b", /does not allow/],
      ["C:\\", /root of a drive/], ["D:\\\\", /root of a drive/], ["C:\\work\\..", /root of a drive/],
    ];
    for (const [input, message] of refused) {
      const rec = recordingFs();
      const r = await inProcess(["lead", "install", "--workspace", input, "--host", "claude"], { fs: rec.fs, path: path.win32 });
      expect.soft([r.code, message.test(r.err), rec.calls], `[win32-refused] ${JSON.stringify(input)} is refused before any file call\n${r.err}`).toEqual([1, true, []]);
    }
    // Ordinary drive paths pass the text check: the first file call is one lstat of the resolved path.
    const accepted: [string, string][] = [
      ["C:\\Data\\Sample User\\work space", "C:\\Data\\Sample User\\work space"],
      ["C:/Data/Sample User/work", "C:\\Data\\Sample User\\work"],
      ["D:\\données\\工作区", "D:\\données\\工作区"],
      ["c:\\data\\sample user\\WORK", "c:\\data\\sample user\\WORK"],
      ["C:\\work\\inner\\..\\other", "C:\\work\\other"],
      ["C:\\work\\.hidden\\v1.2", "C:\\work\\.hidden\\v1.2"],
    ];
    for (const [input, resolved] of accepted) {
      const rec = recordingFs();
      const r = await inProcess(["lead", "status", "--workspace", input, "--host", "codex"], { fs: rec.fs, path: path.win32 });
      expect.soft([r.code, rec.calls, r.err.includes("the workspace does not exist")], `[win32-accepted] ${JSON.stringify(input)} reaches one lstat of the resolved path\n${r.err}`)
        .toEqual([1, [["lstatSync", resolved]], true]);
      expect.soft([path.win32.parse(resolved).root, path.win32.isAbsolute(resolved), path.win32.relative(resolved, path.win32.resolve(resolved, "CLAUDE.md"))]).toEqual([resolved.slice(0, 3), true, "CLAUDE.md"]);
    }
    // Manifest row paths are joined below the workspace only when they are plain relative names.
    const spec = "../src/lead/paths.js";
    const paths = await import(/* @vite-ignore */ spec).catch(() => null);
    expect(paths, "[row-paths-literal] the path map module exists").not.toBeNull();
    const W = "C:\\Data\\Sample User\\work space";
    const joined = (rel: string): string => {
      try {
        return paths.insideWorkspace(path.win32, W, rel);
      } catch (e) {
        return `refused: ${(e as Error).name}`;
      }
    };
    for (const host of ["claude", "codex"]) {
      for (const [, dest] of FROZEN.inventory[host] as string[][]) {
        const full = joined(dest);
        expect.soft([full, path.win32.relative(W, full), path.win32.isAbsolute(path.win32.relative(W, full))], `[row-paths-literal] ${dest} stays below the workspace`)
          .toEqual([`${W}\\${dest.split("/").join("\\")}`, dest.split("/").join("\\"), false]);
      }
    }
    for (const rel of ["../outside", "..\\outside", "a/../../b", "C:\\other", "C:other", "\\\\server\\share", "/abs", "a//b", "a/./b", "a\\b", "a:b", "CON", "a/nul.txt", "a/b.", "a/b ", "", ".", "a/é"]) {
      expect.soft(joined(rel), `[row-paths-literal] ${JSON.stringify(rel)} is not joined`).toBe("refused: RangeError");
    }
    console.log("[observation] lead_win32_roots_and_names: path text rules only; not native Windows proof");
  });
});

describe.skipIf(!RUN)("orch lead: exit codes", () => {
  it("lead_install_file_errors_exit_one_with_optional_result", async () => {
    for (const host of ["claude", "codex"]) for (const [op, rel, word] of [
      ["mkdirSync", ".orch-lead-install", ""],
      ["mkdirSync", ".orch-lead-install/objects", "UNVERIFIABLE_PREPARATION"],
      ["openSync", ".orch-lead-install/objects/00", "PARTIAL"],
    ]) {
      const w = workspace();
      const target = join(w, ...rel.split("/"));
      let hits = 0;
      const original = op === "mkdirSync" ? fs.mkdirSync : fs.openSync;
      const faulty = { ...fs, [op]: (...args: unknown[]) => {
        if (String(args[0]) === target) {
          hits += 1;
          throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC", path: target });
        }
        return (original as (...args: unknown[]) => unknown)(...args);
      } };
      const r = await inProcess(["lead", "install", "--workspace", w, "--host", host], { fs: faulty });
      expect(hits, `${host}/${rel}: the intended fault happened`).toBe(1);
      expect.soft([r.code, resultOf(r.out)], `[file-error-exit-one] ${host}/${rel}: exit 1 regardless of result line\n${r.out}${r.err}`).toEqual([1, word]);
      expect.soft(word ? r.out : r.err, "[file-error-exit-one] the file error and its path are reported").toContain(target);
      expect.soft(word ? r.out : r.err, "[file-error-exit-one] the reported error is ENOSPC").toContain("ENOSPC");
      expect.soft(FROZEN.inventory[host].filter((row: string[]) => existsSync(join(w, ...row[1].split("/")))),
        "[file-error-exit-one] no payload was published before these faults").toEqual([]);
      expect.soft(existsSync(join(w, ".orch-lead-install")), "[file-error-exit-one] state exists only after its mkdir succeeded").toBe(word !== "");
      expect.soft(existsSync(join(w, ".orch-lead-install/manifest.json")), "[file-error-exit-one] only the post-manifest fault has a manifest").toBe(word === "PARTIAL");
    }
    const usage = await inProcess(["lead", "install"]);
    expect.soft([usage.code, resultOf(usage.out)], "[file-error-exit-one] wrong usage exits 1 without a result").toEqual([1, ""]);
    const w = workspace();
    const output = await inProcess(["lead", "install", "--workspace", w, "--host", "claude"], {
      write: (_bytes: Buffer, done: (error: Error) => void) => done(Object.assign(new Error("EPIPE"), { code: "EPIPE" })),
    });
    expect.soft([output.code, resultOf(output.out), readdirSync(w)], "[file-error-exit-one] output failure exits 1 before mutation").toEqual([1, "", []]);
  });

  it("lead_generic_errors_are_escaped_and_exit_one", async () => {
    const w = workspace();
    expect((await inProcess(["lead", "install", "--workspace", w, "--host", "claude"])).code, "install").toBe(0);
    let hits = 0;
    const faulty = {
      ...fs,
      readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
        if (String(args[0]).endsWith(".orch-lead-install")) {
          hits += 1;
          throw new Error("injected disk error\nresult: INSTALLED\u200d");
        }
        return fs.readdirSync(...args);
      },
    };
    for (const command of ["status", "uninstall"]) {
      const r = await inProcess(["lead", command, "--workspace", w, "--host", "claude"], { fs: faulty })
        .catch((e) => ({ code: -1, out: "", err: String(e?.stack ?? e) }));
      const text = r.out + r.err;
      expect.soft(r.code, `[generic-error-escaped] ${command}: exit 1`).toBe(1);
      expect.soft(text.split("\n").filter((line) => line.startsWith("result: ")),
        `[generic-error-escaped] ${command}: no forged result line`).toEqual([]);
      expect.soft(/(?!\n)[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(text),
        `[generic-error-escaped] ${command}: no raw control or invisible character`).toBe(false);
      expect.soft(r.err, `[generic-error-escaped] ${command}: lead error prefix`).toMatch(/^orch lead: error:/);
      expect.soft(r.err, `[generic-error-escaped] ${command}: escaped error text`)
        .toContain("injected disk error\\u000aresult: INSTALLED\\u200d");
    }
    expect(hits, "both commands reached the fault").toBe(2);
  });

  it.skipIf(WINDOWS)("lead_names_from_disk_are_printed_with_control_characters_escaped", async () => {
    // A file name can hold a line break and terminal control codes (not on Windows, which refuses
    // such names). Printed as it is, the name below would add a second result line to the report.
    const w = workspace();
    expect((await inProcess(["lead", "install", "--workspace", w, "--host", "claude"])).code, "install").toBe(0);
    const stray = `x\nresult: INSTALLED\n\u001b[2K\u202e\u200f\u200b\ufeff\u200d\ufe0f\u{e0041}\u{e0020}`;
    writeFileSync(join(w, ".orch-lead-install", stray), "");
    for (const command of ["status", "uninstall"]) {
      const r = await inProcess(["lead", command, "--workspace", w, "--host", "claude"]);
      const text = r.out + r.err;
      expect(text.split("\n").filter((line) => line.startsWith("result: ")), `[names-escaped] ${command}: one result line`).toHaveLength(1);
      expect(/(?!\n)[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(text), `[names-escaped] ${command}: no control, format or invisible character in the output`).toBe(false);
      if (command === "status") {
        expect(resultOf(r.out), "[names-escaped] status: the result is the real one").toBe("PARTIAL");
        expect(r.out, "[names-escaped] status: the name is shown with escapes").toContain("x\\u000aresult: INSTALLED\\u000a\\u001b[2K\\u202e\\u200f\\u200b\\ufeff\\u200d\\ufe0f\\u{e0041}\\u{e0020}");
      }
    }
  });

  it("lead_exit_codes_follow_the_table", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "orch-lead-c-env-")));
    scratch.push(home);
    const lead = (...args: string[]) => {
      const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...args], {
        encoding: "utf8", timeout: 20_000, cwd: home,
        env: { PATH: process.env.PATH, HOME: join(home, "home"), USERPROFILE: join(home, "home"), ORCH_HOME: join(home, "orch-home"), SystemRoot: process.env.SystemRoot },
      });
      return [r.status, resultOf(r.stdout ?? "")];
    };
    const w = workspace();
    const args = ["--workspace", w, "--host", "claude"];
    expect.soft(lead("status", ...args), "[exit-0] status NOT_INSTALLED").toEqual([0, "NOT_INSTALLED"]);
    expect.soft(lead("install", ...args, "--dry-run"), "[exit-0] dry run").toEqual([0, ""]);
    expect.soft(lead("uninstall", ...args), "[exit-0] uninstall with nothing installed").toEqual([0, "NOT_INSTALLED"]);
    expect.soft(lead("install", ...args), "[exit-0] install complete").toEqual([0, "INSTALLED"]);
    expect.soft(lead("status", ...args), "[exit-0] status INSTALLED").toEqual([0, "INSTALLED"]);
    expect.soft(lead("install", ...args), "[exit-2] conflict").toEqual([2, "CONFLICT"]);
    expect.soft(lead("install", ...args, "--dry-run"), "[exit-2] conflict on a dry run").toEqual([2, "CONFLICT"]);
    unlinkSync(join(w, "CLAUDE.md"));
    expect.soft(lead("status", ...args), "[exit-2] status PARTIAL").toEqual([2, "PARTIAL"]);
    writeFileSync(join(w, "CLAUDE.md"), "mine\n");
    expect.soft(lead("uninstall", ...args), "[exit-2] uninstall with a preserved file").toEqual([2, "PARTIAL"]);
    unlinkSync(join(w, "CLAUDE.md"));
    expect.soft(lead("uninstall", ...args), "[exit-0] complete uninstall").toEqual([0, "NOT_INSTALLED"]);
    const prepared = workspace();
    mkdirSync(join(prepared, ".orch-lead-install"));
    expect.soft(lead("status", "--workspace", prepared, "--host", "claude"), "[exit-2] status UNVERIFIABLE_PREPARATION").toEqual([2, "UNVERIFIABLE_PREPARATION"]);
    expect.soft(lead("uninstall", "--workspace", prepared, "--host", "claude"), "[exit-2] uninstall UNVERIFIABLE_PREPARATION").toEqual([2, "UNVERIFIABLE_PREPARATION"]);
    expect.soft(lead("install", "--workspace", w), "[exit-1] a missing argument").toEqual([1, ""]);
    expect.soft(lead("install", "--workspace", w, "--host", "other"), "[exit-1] an unknown host").toEqual([1, ""]);
    expect.soft(lead("status", "--workspace", join(w, "absent"), "--host", "claude"), "[exit-1] a workspace that does not exist").toEqual([1, ""]);
    writeFileSync(join(w, "a-file"), "x");
    expect.soft(lead("status", "--workspace", join(w, "a-file"), "--host", "claude"), "[exit-1] a workspace that is a file").toEqual([1, ""]);
    expect.soft(existsSync(join(home, "orch-home")), "no ORCH home was created").toBe(false);
  });
});
