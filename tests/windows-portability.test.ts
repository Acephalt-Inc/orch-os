// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { main, WINDOWS_WORKERS_UNAVAILABLE } from "../src/cli.js";
import { HANDBOOK, writeHandbook } from "../src/handbook.js";
import { cmdInvocation, quoteCmdArg, which } from "../src/util.js";
import { tmp } from "./_helpers.js";

describe("Windows portability", () => {
  it("resolves PATHEXT commands without requiring a mode bit and keeps POSIX lookup", () => {
    const dir = tmp();
    writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "plain"), "plain\n");
    expect(which("claude", dir, "win32", ".EXE;.CMD;.BAT")).toBe(join(dir, "claude.cmd"));
    expect(which("plain", dir, "win32", ".EXE;.CMD;.BAT")).toBeNull();
    expect(which("plain", [dir, "/bin"].join(delimiter), "linux")).toBeNull();
  });

  it("quotes every cmd metacharacter and builds a fixed interpreter invocation", () => {
    const value = 'a & b|c" %PATH%';
    expect(quoteCmdArg(value)).toBe('"a ^& b^|c"" %%PATH%%"');
    const [exe, args] = cmdInvocation("agent.cmd", [value]);
    expect(exe.toLowerCase()).toContain("cmd");
    expect(args).toEqual(["/d", "/s", "/c", '"agent.cmd" "a ^& b^|c"" %%PATH%%"']);
  });

  it.runIf(process.platform === "win32")("passes a hostile argument through cmd.exe unchanged", () => {
    const value = 'a & b|c" %PATH%';
    const [exe, args] = cmdInvocation(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv[1]))", value]);
    const result = spawnSync(exe, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(value);
  });

  it("normalizes CRLF templates while writing the handbook", () => {
    const source = `${tmp()}${sep}`;
    const target = tmp();
    for (const name of HANDBOOK) writeFileSync(`${source}${name}.md`, `---\r\nname: ${name}\r\n---\r\n`);
    writeHandbook(target, "flat", false, source);
    for (const name of HANDBOOK) expect(readFileSync(`${target}/${name}.md`, "utf8")).not.toContain("\r");
  });

  it("doctor passes its Windows platform row and load reports unavailable signals", async () => {
    const saved = process.env.ORCH_HOME;
    const savedPath = process.env.PATH;
    const bin = tmp();
    writeFileSync(join(bin, "git.cmd"), "@echo off\r\n");
    process.env.ORCH_HOME = tmp();
    process.env.PATH = bin;
    try {
      expect((await main(["init", "--no-handbook"], { out() {}, err() {}, stdin: () => "" }, { platform: "win32" }))).toBe(0);
      let out = "";
      const io = { out: (s: string) => { out += s; }, err() {}, stdin: () => "" };
      expect(await main(["doctor"], io, { platform: "win32" })).toBe(0);
      expect(out).toContain("PASS  windows (no process groups)");
      out = "";
      expect(await main(["load"], io, { platform: "win32" })).toBe(0);
      expect(out).toContain("load_ratio=n/a swap=n/a temp=n/a");
    } finally {
      if (saved === undefined) delete process.env.ORCH_HOME;
      else process.env.ORCH_HOME = saved;
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
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
