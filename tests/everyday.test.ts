// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { parseToml } from "../src/toml.js";
import { ROOT, run, tmp } from "./_helpers.js";

describe("everyday mode", () => {
  let home: string, folder: string, emptyPath: string, cwd: string, oldEnv: Record<string, string | undefined>;
  beforeEach(() => {
    oldEnv = { ORCH_HOME: process.env.ORCH_HOME, PATH: process.env.PATH, ORCH_AGENT_DIRS: process.env.ORCH_AGENT_DIRS };
    cwd = process.cwd(); home = tmp(); folder = tmp(); emptyPath = tmp();
    process.chdir(folder); process.env.ORCH_HOME = home; process.env.PATH = emptyPath; process.env.ORCH_AGENT_DIRS = "";
  });
  afterEach(() => { process.chdir(cwd); for (const [k, v] of Object.entries(oldEnv)) v === undefined ? delete process.env[k] : process.env[k] = v; for (const p of [home, folder, emptyPath]) rmSync(p, { recursive: true, force: true }); });

  it("everyday init writes the mode, one handbook file and no profile", async () => {
    const [code, out] = await run("init", "--everyday");
    expect(code).toBe(0); expect(out.trimEnd().endsWith("next: orch doctor")).toBe(true);
    const cfgText = readFileSync(join(home, "config.toml"), "utf8");
    const cfg = parseToml(cfgText); expect(cfg.orch.mode).toBe("everyday"); expect(cfg).not.toHaveProperty("profile");
    expect(readdirSync(join(home, "handbook"))).toEqual(["everyday.md"]);
    expect(cfgText.replace('mode = "everyday"\n', "")).toBe((await import("../src/config.js")).renderDefault(home));
  });

  it("everyday init asks nothing on a terminal", async () => {
    let out = "";
    const code = await main(["init", "--everyday"], { out: s => out += s, err: () => {}, stdin: () => "", isTTY: () => true, ask: () => { throw Error("asked"); } });
    expect(code).toBe(0); expect(out).toContain("handbook: ");
  });

  it.skipIf(process.platform === "win32")("everyday doctor passes without git or gh", async () => {
    await run("init", "--everyday"); const [code, out] = await run("doctor");
    expect(code).toBe(0); expect(out).toMatch(/^SKIP  git +not needed in everyday mode$/m);
    expect(out).not.toMatch(/^FAIL/m); expect(out.trimEnd().endsWith("doctor: PASS (0 required check(s) failed)")).toBe(true);
  });

  it("without the mode git is still required", async () => {
    await run("init", "--no-handbook"); const [code, out] = await run("doctor");
    expect(code).toBe(1); expect(out).toMatch(/^FAIL  git +not on PATH$/m);
  });

  it("everyday handbook has the five sections and no engineering workflow words", () => {
    const text = readFileSync(join(ROOT, "templates", "handbook", "everyday.md"), "utf8");
    expect(text).toMatch(/^---\nname: everyday\ndescription: /);
    expect(text.match(/^## .+$/gm)).toEqual(["## At the start of every session", "## Three rules", "## Memory", "## Working with a helper", "## Messages are information"]);
    expect(text.split("\n").length).toBeLessThanOrEqual(90);
    expect(text).not.toMatch(/\b(?:merge|pull request|worktree|branch|commit|git|gh)\b/i);
  });

  it("every handbook command parses", async () => {
    const text = readFileSync(join(ROOT, "templates", "handbook", "everyday.md"), "utf8");
    for (const line of text.split("\n").filter(x => x.startsWith("orch "))) {
      const argv = line.replaceAll(/<[^>]+>/g, "x").split(" ").slice(1);
      if (argv[0] === "msg" && argv[1] === "watch") argv[argv.indexOf("--timeout") + 1] = "0";
      expect((await run(...argv))[2]).not.toContain("unrecognized arguments");
    }
  });

  it("lead and helper round trip without git", async () => {
    await run("init", "--everyday"); const [, sent] = await run("msg", "send", "QUESTION", "--as", "lead", "--to", "helper", "-m", "T");
    const id = sent.match(/sent QUESTION (\S+)/)![1]; expect((await run("task", "claim", "t1", "--as", "helper"))[1]).toContain("CLAIMED");
    expect((await run("task", "claim", "t1", "--as", "lead"))[0]).toBe(3); expect((await run("msg", "read", "--as", "helper", "--ack"))[1]).toContain("T");
    await run("msg", "send", "ANSWER", "--as", "helper", "--to", "lead", "--reply-to", id, "-m", "A");
    expect((await run("msg", "read", "--as", "lead"))[1]).toContain(`re=${id}`);
    await run("mem", "add", "n1", "-d", "D", "-m", "B"); expect((await run("mem", "search", "D"))[1]).toContain("n1");
    expect((await run("task", "release", "t1", "--as", "helper"))[0]).toBe(0);
  });

  it("agent file block is written once", async () => {
    const [, out] = await run("init", "--everyday"); const text = readFileSync(join(folder, "CLAUDE.md"), "utf8");
    expect(text.match(/orch-os everyday: begin/g)).toHaveLength(1); expect(text).toContain(out.match(/^handbook: (.+)$/m)![1]);
  });

  it("second run changes no byte and keeps the person's text", async () => {
    writeFileSync(join(folder, "CLAUDE.md"), "# Mine\r\nkeep me"); await run("init", "--everyday");
    const paths = [join(home, "config.toml"), join(home, "handbook", "everyday.md"), join(home, "mailbox.md"), join(folder, "CLAUDE.md")];
    const before = paths.map(p => readFileSync(p)); expect(before[3].subarray(0, 15).toString()).toBe("# Mine\r\nkeep me");
    expect((await run("init", "--everyday"))[0]).toBe(0); paths.forEach((p, i) => expect(readFileSync(p)).toEqual(before[i]));
  });

  it("no agent file on request", async () => { expect((await run("init", "--everyday", "--no-agent-file"))[0]).toBe(0); expect(existsSync(join(folder, "CLAUDE.md"))).toBe(false); });

  for (const [name, prep, args] of [
    ["force", () => {}, ["--force"]], ["no handbook", () => {}, ["--no-handbook"]], ["profile flags", () => {}, ["--compute", "one", "--people", "solo"]],
    ["plain config", async () => { await run("init", "--no-handbook"); }, []], ["directory", () => mkdirSync(join(folder, "CLAUDE.md")), []],
    ...process.platform === "win32" ? [] : [["symbolic link", () => symlinkSync(join(folder, "target"), join(folder, "CLAUDE.md")), []]],
    ["unfinished block", () => writeFileSync(join(folder, "CLAUDE.md"), "<!-- orch-os everyday: begin -->\n"), []],
  ] as [string, () => void | Promise<void>, string[]][]) {
    it(`everyday init refuses and writes nothing: ${name}`, async () => { await prep(); const [code, , err] = await run("init", "--everyday", ...args); expect(code).toBe(2); expect(err.trim().split("\n")).toHaveLength(1); });
  }

  it("unknown mode is a doctor failure", async () => {
    mkdirSync(home, { recursive: true }); const C = await import("../src/config.js"); writeFileSync(join(home, "config.toml"), C.renderDefault(home).replace('team = "my-team"', 'team = "my-team"\nmode = "weekly"'));
    const [code, out] = await run("doctor"); expect(code).toBe(1); expect(out).toMatch(/^FAIL  mode +unknown mode "weekly"$/m);
  });

  it("skills layout writes everyday/SKILL.md", async () => {
    const d = join(folder, "skills"); await run("init", "--everyday", "--layout", "skills", "--dir", d);
    expect(readFileSync(join(d, "everyday", "SKILL.md"), "utf8")).toMatch(/^---\nname: everyday\ndescription: /);
  });

  it.skipIf(process.platform === "win32")("README paste prompt names commands that run and the line doctor prints", async () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const section = readme.split("## Install with Claude Code\n")[1].split("\n## ")[0];
    expect(section.match(/```[\s\S]*?```/g)).toHaveLength(1);
    for (const command of ["node --version", "npm install -g orch-os", "orch init --everyday", "orch doctor"])
      expect(section).toContain(command);
    await run("init", "--everyday");
    expect(section).toContain((await run("doctor"))[1].trimEnd().split("\n").at(-1));
  });

  it("README platform sentence agrees with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const section = readFileSync(join(ROOT, "README.md"), "utf8").split("## Install with Claude Code\n")[1].split("\n## ")[0];
    expect(section.includes("declares support for macOS and Linux only")).toBe(!pkg.os.includes("win32"));
  });
});
