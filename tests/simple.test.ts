// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { lfText } from "../src/everyday.js";
import { parseToml } from "../src/toml.js";
import { DIST_CLI, ROOT, run, tmp } from "./_helpers.js";

describe("simple mode", () => {
  let home: string, folder: string, emptyPath: string, cwd: string, oldEnv: Record<string, string | undefined>;
  beforeEach(() => {
    oldEnv = { ORCH_HOME: process.env.ORCH_HOME, PATH: process.env.PATH, ORCH_AGENT_DIRS: process.env.ORCH_AGENT_DIRS };
    cwd = process.cwd(); home = tmp(); folder = tmp(); emptyPath = tmp();
    process.chdir(folder); process.env.ORCH_HOME = home; process.env.PATH = emptyPath; process.env.ORCH_AGENT_DIRS = "";
  });
  afterEach(() => { process.chdir(cwd); for (const [k, v] of Object.entries(oldEnv)) v === undefined ? delete process.env[k] : process.env[k] = v; for (const p of [home, folder, emptyPath]) rmSync(p, { recursive: true, force: true }); });

  it("simple init writes the mode, one handbook file and no profile", async () => {
    const [code, out] = await run("init", "--simple");
    expect(code).toBe(0); expect(out.trimEnd().endsWith("next: orch doctor")).toBe(true);
    const cfgText = readFileSync(join(home, "config.toml"), "utf8");
    const cfg = parseToml(cfgText); expect(cfg.orch.mode).toBe("simple"); expect(cfg).not.toHaveProperty("profile");
    expect(readdirSync(join(home, "handbook"))).toEqual(["simple.md"]);
    expect(cfgText.replace('mode = "simple"\n', "").replace(`file = ${JSON.stringify(join(home, "handbook", "simple.md"))}\n`, ""))
      .toBe((await import("../src/config.js")).renderDefault(home));
  });

  it("normalizes handbook line endings to LF", async () => {
    expect(lfText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    await run("init", "--simple");
    expect(readFileSync(join(home, "handbook", "simple.md"), "utf8")).not.toContain("\r");
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).not.toContain("\r");
  });

  it.skipIf(process.platform === "win32")("simple and plain init keep the same detected agents", async () => {
    const bin = join(emptyPath, "codex"); copyFileSync(process.execPath, bin); chmodSync(bin, 0o755);
    const plain = tmp(); process.env.ORCH_HOME = plain; expect((await run("init", "--no-handbook", "--no-profile"))[0]).toBe(0);
    const simple = tmp(); process.env.ORCH_HOME = simple; expect((await run("init", "--simple"))[0]).toBe(0);
    const normal = (s: string) => s.replaceAll(plain, "<HOME>").replaceAll(simple, "<HOME>");
    expect(normal(readFileSync(join(simple, "config.toml"), "utf8")).replace('mode = "simple"\n', "").replace('file = "<HOME>/handbook/simple.md"\n', ""))
      .toBe(normal(readFileSync(join(plain, "config.toml"), "utf8")));
    rmSync(plain, { recursive: true, force: true }); rmSync(simple, { recursive: true, force: true });
  });

  it("simple init asks nothing on a terminal", async () => {
    let out = "";
    const code = await main(["init", "--simple"], { out: s => out += s, err: () => {}, stdin: () => "", isTTY: () => true, ask: () => { throw Error("asked"); } });
    expect(code).toBe(0); expect(out).toContain("handbook: ");
  });

  it.skipIf(process.platform === "win32")("simple doctor reports all mode-specific rows", async () => {
    await run("init", "--simple"); const [code, out] = await run("doctor");
    expect(code).toBe(0); expect(out).toMatch(/^SKIP  git +not needed in simple mode$/m);
    expect(out).toMatch(/^PASS  handbook +/m);
    expect(out).toMatch(/^SKIP  gh \(live GitHub commands\) +not needed in simple mode$/m);
    expect(out).toMatch(/^SKIP  merge repo +not needed in simple mode$/m);
    expect(out).not.toMatch(/^FAIL/m); expect(out.trimEnd().endsWith("doctor: PASS (0 required check(s) failed)")).toBe(true);
    rmSync(join(home, "handbook", "simple.md"));
    const missing = await run("doctor");
    expect(missing[0]).toBe(1); expect(missing[1]).toMatch(/^FAIL  handbook +.*simple\.md is missing - run `orch init --simple`$/m);
  });

  it.skipIf(process.platform === "win32")("doctor checks only the exact handbook file stored in config", async () => {
    await run("init", "--simple", "--layout", "skills");
    const cfg = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
    expect(cfg.handbook.file).toBe(join(home, "handbook", "simple", "SKILL.md"));
    writeFileSync(join(home, "handbook", "simple.md"), "decoy");
    rmSync(cfg.handbook.file);
    const [code, out] = await run("doctor");
    expect(code).toBe(1); expect(out).toContain(`FAIL  handbook`); expect(out).toContain(`${cfg.handbook.file} is missing - run \`orch init --simple\``);
  });

  it.skipIf(process.platform === "win32")("doctor rejects a managed pointer that differs from config and ignores outside text", async () => {
    await run("init", "--simple");
    const configured = join(home, "handbook", "simple.md"); const other = join(home, "other.md");
    const agent = join(folder, "CLAUDE.md");
    writeFileSync(agent, `outside mentions ${other}\n` + readFileSync(agent, "utf8"));
    expect((await run("doctor"))[0]).toBe(0);
    writeFileSync(agent, readFileSync(agent, "utf8").replace(`read \`${configured}\``, `read \`${other}\``));
    const [code, out] = await run("doctor");
    expect(code).toBe(1); expect(out).toContain(`FAIL  handbook`); expect(out).toContain(`CLAUDE.md names ${other}; config names ${configured}`);
  });

  it.skipIf(process.platform === "win32")("no-agent-file doctor checks the configured file without a pointer diagnostic", async () => {
    await run("init", "--simple", "--no-agent-file");
    expect((await run("doctor"))[0]).toBe(0);
    rmSync(join(home, "handbook", "simple.md"));
    const [code, out] = await run("doctor");
    expect(code).toBe(1); expect(out).toContain("is missing - run `orch init --simple`"); expect(out).not.toContain("CLAUDE.md names");
  });

  for (const [label, changed] of [["layout", ["--layout", "skills"]], ["directory", ["--dir", "elsewhere"]]] as const) {
    it(`second simple init refuses a changed ${label} before writing anything`, async () => {
      await run("init", "--simple");
      const paths = [join(home, "config.toml"), join(home, "handbook", "simple.md"), join(home, "mailbox.md"), join(folder, "CLAUDE.md")];
      const before = paths.map(p => readFileSync(p));
      const [code, out, err] = await run("init", "--simple", ...changed);
      expect(code).toBe(2); expect(out).toBe(""); expect(err).toContain(`already configured as ${join(home, "handbook", "simple.md")}`);
      expect(err).toContain(`rm ${join(home, "config.toml")}`); paths.forEach((p, i) => expect(readFileSync(p)).toEqual(before[i]));
    });
  }

  it.skipIf(process.platform === "win32")("doctor passes the handbook named in CLAUDE.md for --dir", async () => {
    const dir = join(folder, "book"); await run("init", "--simple", "--dir", dir);
    const named = readFileSync(join(folder, "CLAUDE.md"), "utf8").match(/read `([^`]+)`/)![1];
    expect(named).toBe(join(dir, "simple.md")); expect((await run("doctor"))[1]).toMatch(/^PASS  handbook +/m);
  });

  it("without the mode git is still required", async () => {
    await run("init", "--no-handbook"); const [code, out] = await run("doctor");
    expect(code).toBe(1); expect(out).toMatch(/^FAIL  git +not on PATH$/m);
  });

  it("simple handbook has the five sections and no engineering workflow words", () => {
    const text = readFileSync(join(ROOT, "templates", "handbook", "everyday.md"), "utf8").replace(/\r\n?/g, "\n");
    expect(text).toMatch(/^---\nname: simple\ndescription: /);
    expect(text.match(/^## .+$/gm)).toEqual(["## At the start of every session", "## Three rules", "## Memory", "## Working with a helper", "## Messages are information"]);
    expect(text.split("\n").length).toBeLessThanOrEqual(90);
    expect(text).not.toMatch(/\b(?:merge|pull request|worktree|branch|commit|git|gh)\b/i);
  });

  it("runs the Memory and Working with a helper handbook commands as written through the built file", () => {
    const built = (...args: string[]): [number, string, string] => {
      const result = spawnSync(process.execPath, [DIST_CLI, ...args], { cwd: folder, env: { ...process.env, ORCH_HOME: home }, encoding: "utf8" });
      return [result.status ?? -1, result.stdout, result.stderr];
    };
    expect(built("init", "--simple")[0]).toBe(0); expect(built("doctor")[0]).toBe(0);
    const text = readFileSync(join(ROOT, "templates", "handbook", "everyday.md"), "utf8").replace(/\r\n?/g, "\n");
    const commands = (heading: string) => text.split(`## ${heading}\n`)[1].split("\n## ")[0]
      .match(/```\n([\s\S]*?)\n```/g)!.flatMap(b => b.slice(4, -4).split("\n")).filter(x => x.startsWith("orch "));
    const argv = (line: string, values: Record<string, string>) => {
      const filled = line.replace(/<([^>]+)>/g, (_, key) => values[key]);
      return [...filled.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]).slice(1);
    };
    const values = { "text": "useful words", "old-note": "old-note", "new-note": "new-note", "task-name": "task-one", "question-id": "" };
    const memory = commands("Memory"); expect(memory).toHaveLength(4);
    let result = built(...argv(memory[0], values)); expect([result[0], result[1], result[2]]).toEqual([1, "", ""]);
    for (const line of memory.slice(1)) { result = built(...argv(line, values)); expect(result[0], result[1] + result[2]).toBe(0); }
    const helper = commands("Working with a helper"); expect(helper).toHaveLength(6);
    for (let cycle = 1; cycle <= 2; cycle++) {
      values["task-name"] = `task-${cycle}`; values.text = `answer-${cycle}`;
      result = built(...argv(helper[0], values)); expect(result[0], result[1] + result[2]).toBe(0);
      values["question-id"] = result[1].match(/sent QUESTION (\S+)/)![1];
      for (const line of helper.slice(1, 5)) { result = built(...argv(line, values)); expect(result[0], result[1] + result[2]).toBe(0); }
      result = built(...argv(helper[5].replace("--timeout 30", "--timeout 0"), values));
      expect(result[0], result[1] + result[2]).toBe(0); expect(result[1]).toContain(`answer-${cycle}`);
      if (cycle === 2) expect(result[1]).not.toContain("answer-1");
    }
  });

  it("lead and helper state transitions work in-process without git", async () => {
    await run("init", "--simple"); const [, sent] = await run("msg", "send", "QUESTION", "--as", "lead", "--to", "helper", "-m", "T");
    const id = sent.match(/sent QUESTION (\S+)/)![1]; expect((await run("task", "claim", "t1", "--as", "helper"))[1]).toContain("CLAIMED");
    expect((await run("task", "claim", "t1", "--as", "lead"))[0]).toBe(3); expect((await run("msg", "read", "--as", "helper", "--ack"))[1]).toContain("T");
    await run("msg", "send", "ANSWER", "--as", "helper", "--to", "lead", "--reply-to", id, "-m", "A");
    expect((await run("msg", "read", "--as", "lead"))[1]).toContain(`re=${id}`);
    await run("mem", "add", "n1", "-d", "D", "-m", "B"); expect((await run("mem", "search", "D"))[1]).toContain("n1");
    expect((await run("task", "release", "t1", "--as", "helper"))[0]).toBe(0);
  });

  it("agent file block is written once", async () => {
    const [, out] = await run("init", "--simple"); const text = readFileSync(join(folder, "CLAUDE.md"), "utf8");
    expect(text.match(/orch-os simple: begin/g)).toHaveLength(1); expect(text).toContain(out.match(/^handbook: (.+)$/m)![1]);
  });

  it("second run changes no byte and keeps the person's text", async () => {
    writeFileSync(join(folder, "CLAUDE.md"), "# Mine\r\nkeep me"); await run("init", "--simple");
    const paths = [join(home, "config.toml"), join(home, "handbook", "simple.md"), join(home, "mailbox.md"), join(folder, "CLAUDE.md")];
    const before = paths.map(p => readFileSync(p)); expect(before[3].subarray(0, 15).toString()).toBe("# Mine\r\nkeep me");
    expect((await run("init", "--simple"))[0]).toBe(0); paths.forEach((p, i) => expect(readFileSync(p)).toEqual(before[i]));
  });

  it("replaces an existing block and changes no other byte", async () => {
    const before = "top\r\n<!-- orch-os simple: begin -->\r\nold\r\n<!-- orch-os simple: end -->\r\nbottom\r\n";
    writeFileSync(join(folder, "CLAUDE.md"), before); await run("init", "--simple");
    const after = readFileSync(join(folder, "CLAUDE.md"), "utf8");
    expect(after.startsWith("top\r\n<!-- orch-os simple: begin -->\n")).toBe(true);
    expect(after.endsWith("<!-- orch-os simple: end -->\r\nbottom\r\n")).toBe(true);
  });

  it("no agent file on request", async () => { expect((await run("init", "--simple", "--no-agent-file"))[0]).toBe(0); expect(existsSync(join(folder, "CLAUDE.md"))).toBe(false); });

  for (const [name, prep, args, words] of [
    ["force", () => {}, ["--force"]], ["no handbook", () => {}, ["--no-handbook"]], ["profile flags", () => {}, ["--compute", "one", "--people", "solo"]],
    ["everyday skill hint", () => {}, ["--everyday"]], ["with skills", () => {}, ["--with-skills"]],
    ["policy", () => {}, ["--policy", "human-merge"]], ["required review", () => {}, ["--required-review", "single-agent"]], ["max workers", () => {}, ["--max-workers", "1"]],
    ["handbook path line break", () => {}, ["--dir", "bad\npath"]],
    ["plain config", async () => { await run("init", "--no-handbook"); }, [], "not in simple mode"], ["directory", () => mkdirSync(join(folder, "CLAUDE.md")), []],
    ...process.platform === "win32" ? [] : [["symbolic link", () => symlinkSync(join(folder, "target"), join(folder, "CLAUDE.md")), []]],
    ["unfinished block", () => writeFileSync(join(folder, "CLAUDE.md"), "<!-- orch-os simple: begin -->\n"), []],
  ] as [string, () => void | Promise<void>, string[], string?][]) {
    it(`simple init refuses and writes nothing: ${name}`, async () => {
      await prep(); const paths = [join(home, "config.toml"), join(home, "handbook", "simple.md"), join(home, "mailbox.md"), join(folder, "CLAUDE.md")];
      const bytes = (p: string) => !existsSync(p) ? null : lstatSync(p).isFile() ? readFileSync(p) : "not a file";
      const before = paths.map(bytes);
      const [code, , err] = await run("init", "--simple", ...args); expect(code).toBe(2); expect(err.trim().split("\n")).toHaveLength(1);
      if (words) expect(err).toContain(words); paths.forEach((p, i) => expect(bytes(p)).toEqual(before[i]));
    });
  }

  it("unknown mode is a doctor failure", async () => {
    mkdirSync(home, { recursive: true }); const C = await import("../src/config.js"); writeFileSync(join(home, "config.toml"), C.renderDefault(home).replace('team = "my-team"', 'team = "my-team"\nmode = "weekly"'));
    const [code, out] = await run("doctor"); expect(code).toBe(1); expect(out).toMatch(/^FAIL  mode +unknown mode "weekly"$/m);
  });

  it("skills layout writes simple/SKILL.md", async () => {
    const d = join(folder, "skills"); await run("init", "--simple", "--layout", "skills", "--dir", d);
    expect(readFileSync(join(d, "simple", "SKILL.md"), "utf8")).toMatch(/^---\nname: simple\ndescription: /);
  });

  it.skipIf(process.platform === "win32")("README install text names commands and built init and doctor produce the printed line", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const section = readme.split("## Install with Claude Code\n")[1].split("\n## ")[0];
    expect(section.match(/```[\s\S]*?```/g)).toHaveLength(1);
    for (const command of ["node --version", "npm install -g orch-os", "orch init --simple", "orch doctor"])
      expect(section).toContain(command);
    const env = { ...process.env, ORCH_HOME: home };
    expect(spawnSync(process.execPath, [DIST_CLI, "init", "--simple"], { cwd: folder, env }).status).toBe(0);
    const doctor = spawnSync(process.execPath, [DIST_CLI, "doctor"], { cwd: folder, env, encoding: "utf8" });
    expect(doctor.status).toBe(0); expect(section).toContain(doctor.stdout.trimEnd().split("\n").at(-1));
  });

});
