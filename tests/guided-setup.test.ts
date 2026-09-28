// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type IO } from "../src/cli.js";
import { runRecommendations } from "../src/recommend.js";
import { parseToml } from "../src/toml.js";
import { keepEnv, useTmpHome } from "./_helpers.js";

describe("guided setup", () => {
  const ctx = useTmpHome();
  keepEnv(["PATH", "LANG", "ORCH_AGENT_DIRS"]);

  function env(): void {
    process.env.PATH = "/usr/bin:/bin";
    process.env.ORCH_AGENT_DIRS = "";
    process.env.LANG = "en_US.UTF-8";
  }

  async function invoke(argv: string[], answers = "", tty = false): Promise<[number, string, string]> {
    let out = "", err = "";
    const lines = answers.split("\n");
    const io = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => answers,
      isTTY: () => tty,
      ask: (question) => { out += question; return lines.shift() ?? ""; },
    } as IO;
    const previous = process.cwd();
    process.chdir(ctx.home);
    try { return [await main(argv, io), out, err]; }
    finally { process.chdir(previous); }
  }

  const config = () => readFileSync(join(ctx.home, "config.toml"), "utf8");

  it("keeps no-flag non-TTY init stdout and config byte-identical to the baseline", async () => {
    env();
    const [code, out, err] = await invoke(["init"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out.replaceAll(ctx.home, "<ORCH_HOME>")).toBe(
      "agents: none of claude, codex, gemini, qwen found on PATH (workers still run any command given after --)\n" +
      "wrote <ORCH_HOME>/config.toml\n" +
      "wrote <ORCH_HOME>/mailbox.md\n" +
      "wrote <ORCH_HOME>/handbook/lead-boot.md\n" +
      "wrote <ORCH_HOME>/handbook/worker-boot.md\n" +
      "wrote <ORCH_HOME>/handbook/review-boot.md\n" +
      "wrote <ORCH_HOME>/handbook/protocols.md\n" +
      "boot: point each agent session at its role file, e.g. <ORCH_HOME>/handbook/lead-boot.md (see docs/faq.md)\n" +
      "next: orch doctor\n",
    );
    const normalized = config().replaceAll(ctx.home, "<ORCH_HOME>");
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(
      "ac09907868f8557eb51927d210b7ad7dc118da5ccbe0912e77da9e23865bc8e6",
    );
  });

  it("--yes accepts defaults without questions or add-on installs", async () => {
    env();
    const [code, out] = await invoke(["init", "--yes"]);
    expect(code).toBe(0);
    expect(out).not.toContain("Question 1");
    expect(out).not.toContain("claude plugin");
    expect(parseToml(config()).profile).toMatchObject({ compute: "one", people: "solo" });
    expect(parseToml(config()).setup).toMatchObject({ language: "en", level: "some", style: "standard" });
  });

  it("asks six ordered questions and runs only selected add-ons", async () => {
    env();
    const [code, out] = await invoke(["init"], "zh\nteam\nnew\nyes\nconcise-tables\n1,3", true);
    expect(code).toBe(0);
    for (let n = 1; n <= 6; n++) expect(out).toContain(`Question ${n}/6`);
    expect(parseToml(config()).profile).toMatchObject({ compute: "one", people: "team" });
    expect(parseToml(config()).setup).toMatchObject({ language: "zh", level: "new", style: "concise-tables" });
    expect(readFileSync(join(ctx.home, "handbook/setup-guide.md"), "utf8")).toContain("设置指南");
    expect(existsSync(join(ctx.home, ".claude/output-styles/orch-concise.md"))).toBe(true);
    expect(readFileSync(join(ctx.home, ".claude/output-styles/orch-concise.md"), "utf8")).toContain("keep-coding-instructions: true");
    expect(JSON.parse(readFileSync(join(ctx.home, ".claude/settings.local.json"), "utf8")).outputStyle).toBe("orch-concise");
    expect(readFileSync(join(ctx.home, "AGENTS.md"), "utf8")).toContain("ORCH-os concise tables");
    expect(out).toContain("anthropics/claude-plugins-official");
    expect(out).toContain("obra/superpowers");
    expect(out).not.toContain("claude plugin marketplace add ayghri");
    expect(out).not.toContain("claude plugin marketplace add JuliusBrussee");
  });

  it("setup uses current answers, changes only requested values, and is idempotent", async () => {
    env();
    expect((await invoke(["init", "--yes"]))[0]).toBe(0);
    const before = config();
    const args = ["setup", "--lang", "zh", "--team", "--level", "new", "--style", "concise-tables", "--no-recommend"];
    expect((await invoke(args))[0]).toBe(0);
    const changed = config();
    expect(changed).not.toBe(before);
    expect(parseToml(changed).profile).toMatchObject({ compute: "one", people: "team" });
    expect(parseToml(changed).setup).toMatchObject({ language: "zh", level: "new", style: "concise-tables" });
    expect((await invoke(args))[0]).toBe(0);
    expect(config()).toBe(changed);
  });

  it("flags are non-interactive and legacy profile flags retain their behavior", async () => {
    env();
    const [code, out] = await invoke(["init", "--yes", "--lang", "zh", "--solo", "--level", "developer", "--style", "skip", "--no-recommend"], "", true);
    expect(code).toBe(0);
    expect(out).not.toContain("Question 1");
    expect(parseToml(config()).profile).toMatchObject({ compute: "one", people: "solo" });
    expect(parseToml(config()).setup).toMatchObject({ language: "zh", level: "developer", style: "skip" });
    expect(existsSync(join(ctx.home, ".claude/output-styles/orch-concise.md"))).toBe(false);
  });

  it("keeps the explicit no-handbook legacy two-question flow without guided flags", async () => {
    env();
    const [code, out] = await invoke(["init", "--no-handbook"], "\nteam", true);
    expect(code).toBe(0);
    expect(out).toContain("How many agent accounts");
    expect(out).not.toContain("Question 1/6");
    expect(parseToml(config()).profile).toMatchObject({ compute: "one", people: "team" });
    expect(parseToml(config()).setup).toBeUndefined();
    expect(existsSync(join(ctx.home, "handbook"))).toBe(false);
  });

  it("new guided flags with no-handbook still suppress every handbook file", async () => {
    env();
    const [code] = await invoke(["init", "--no-handbook", "--yes", "--level", "new"]);
    expect(code).toBe(0);
    expect(parseToml(config()).setup).toMatchObject({ level: "new", style: "concise-tables" });
    expect(existsSync(join(ctx.home, "handbook"))).toBe(false);
  });

  it("TTY EOF cancels before init writes any file", async () => {
    env();
    let out = "", err = "";
    const code = await main(["init"], {
      out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => "",
      isTTY: () => true, ask: () => null,
    });
    expect(code).toBe(2);
    expect(err).toContain("cancelled");
    expect(out).toBe("");
    expect(existsSync(join(ctx.home, "config.toml"))).toBe(false);
  });

  it("setup preserves existing profile accounts and unrelated config when changing people", async () => {
    env();
    expect((await invoke(["init", "--compute", "same-vendor", "--people", "solo"]))[0]).toBe(0);
    expect((await invoke(["profile", "update", "--account", "primary=claude", "--account", "secondary=claude"]))[0]).toBe(0);
    const before = parseToml(config());
    expect((await invoke(["setup", "--team", "--no-recommend"]))[0]).toBe(0);
    const after = parseToml(config());
    expect(after.profile.compute).toBe("same-vendor");
    expect(after.profile.people).toBe("team");
    expect(after.profile.accounts).toEqual(before.profile.accounts);
    expect(after.mailbox).toEqual(before.mailbox);
  });

  it("selected recommendations print commands but do not execute without Claude CLI", async () => {
    env();
    const [code, out] = await invoke(["init"], "\n\n\n\n\n4", true);
    expect(code).toBe(0);
    expect(out).toContain("claude plugin marketplace add ayghri/i-have-adhd");
  });

  it("runs only selected add-on commands, prints first, and continues after failure", () => {
    const events: string[] = [];
    runRecommendations([2, 3], (s) => events.push(`print:${s}`), "/fake/claude", (bin, args) => {
      events.push(`run:${bin} ${args.join(" ")}`);
      return args.includes("superpowers@superpowers-dev") ? 1 : 0;
    });
    expect(events.filter((s) => s.startsWith("run:"))).toHaveLength(4);
    expect(events.findIndex((s) => s === "print:claude plugin marketplace add obra/superpowers"))
      .toBeLessThan(events.findIndex((s) => s === "run:/fake/claude plugin marketplace add obra/superpowers"));
    expect(events).toContain("print:  command failed; continuing");
    expect(events.some((s) => s.includes("ayghri/i-have-adhd"))).toBe(true);
    expect(events.some((s) => s.includes("JuliusBrussee/caveman"))).toBe(false);
  });

  it("Anthropic skills selection installs its documented plugin, not just the marketplace", () => {
    const commands: string[] = [];
    runRecommendations([1], () => {}, "/fake/claude", (_bin, args) => {
      commands.push(args.join(" ")); return 0;
    });
    expect(commands).toEqual([
      "plugin marketplace add anthropics/skills",
      "plugin install document-skills@anthropic-agent-skills",
    ]);
  });

  it("safely merges Claude settings, reverts only managed style, and skip makes no switch", async () => {
    env();
    expect((await invoke(["init", "--yes", "--style", "standard"]))[0]).toBe(0);
    const settings = join(ctx.home, ".claude/settings.local.json");
    mkdirSync(join(ctx.home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"permissions":{"allow":["Read"]},"model":"sonnet"}\n');
    writeFileSync(join(ctx.home, "AGENTS.md"), "# User notes\n\nKeep this paragraph.\n");
    expect((await invoke(["setup", "--style", "concise-tables", "--no-recommend"]))[0]).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({
      permissions: { allow: ["Read"] }, model: "sonnet", outputStyle: "orch-concise",
    });
    const active = config();
    expect((await invoke(["setup", "--style", "skip", "--no-recommend"]))[0]).toBe(0);
    expect(config()).toBe(active);
    expect(JSON.parse(readFileSync(settings, "utf8")).outputStyle).toBe("orch-concise");
    expect((await invoke(["setup", "--style", "standard", "--no-recommend"]))[0]).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Read"] }, model: "sonnet" });
    expect(readFileSync(join(ctx.home, "AGENTS.md"), "utf8")).toBe("# User notes\n\nKeep this paragraph.\n");
  });

  it("refuses malformed Claude project settings without overwriting it or config", async () => {
    env();
    expect((await invoke(["init", "--yes", "--style", "standard"]))[0]).toBe(0);
    const settings = join(ctx.home, ".claude/settings.local.json");
    mkdirSync(join(ctx.home, ".claude"), { recursive: true });
    writeFileSync(settings, "{broken-json");
    const before = config();
    const [code, , err] = await invoke(["setup", "--style", "concise-tables", "--no-recommend"]);
    expect(code).toBe(2);
    expect(err).toContain("settings.local.json");
    expect(readFileSync(settings, "utf8")).toBe("{broken-json");
    expect(config()).toBe(before);
  });

  it("rerun with current defaults does not reclaim a user-selected Claude style", async () => {
    env();
    expect((await invoke(["init", "--yes", "--level", "new"]))[0]).toBe(0);
    const settings = join(ctx.home, ".claude/settings.local.json");
    const current = JSON.parse(readFileSync(settings, "utf8"));
    current.outputStyle = "My Style";
    writeFileSync(settings, JSON.stringify(current) + "\n");
    const before = config();
    expect((await invoke(["setup", "--yes"]))[0]).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).outputStyle).toBe("My Style");
    expect(config()).toBe(before);
  });

  it("refuses to activate a customized ORCH style file without overwriting user content", async () => {
    env();
    expect((await invoke(["init", "--yes", "--style", "standard"]))[0]).toBe(0);
    const file = join(ctx.home, ".claude/output-styles/orch-concise.md");
    mkdirSync(join(ctx.home, ".claude/output-styles"), { recursive: true });
    writeFileSync(file, "# My own style\n");
    const before = config();
    const [code, , err] = await invoke(["setup", "--style", "concise-tables", "--no-recommend"]);
    expect(code).toBe(2);
    expect(err).toContain("orch-concise.md");
    expect(readFileSync(file, "utf8")).toBe("# My own style\n");
    expect(config()).toBe(before);
  });

  it("changes only profile.people bytes and preserves profile comments", async () => {
    env();
    expect((await invoke(["init", "--compute", "one", "--people", "solo"]))[0]).toBe(0);
    const old = config().replace('people = "solo"', 'people = "solo" # user comment');
    writeFileSync(join(ctx.home, "config.toml"), old);
    expect((await invoke(["setup", "--team", "--no-recommend"]))[0]).toBe(0);
    expect(config().startsWith(old.replace('people = "solo"', 'people = "team"'))).toBe(true);
  });

  it("changes only requested setup keys without dropping setup comments", async () => {
    env();
    expect((await invoke(["init", "--yes", "--style", "standard"]))[0]).toBe(0);
    const old = config().replace('language = "en"', 'language = "en" # user comment')
      .replace('level = "some"', "level   =   'some'  # retain spacing and quote style");
    writeFileSync(join(ctx.home, "config.toml"), old);
    expect((await invoke(["setup", "--lang", "zh", "--no-recommend"]))[0]).toBe(0);
    expect(config()).toBe(old.replace('language = "en"', 'language = "zh"'));
  });

  it("explicit standard selects Claude default while preserving unrelated project settings", async () => {
    env();
    expect((await invoke(["init", "--yes", "--style", "standard"]))[0]).toBe(0);
    const path = join(ctx.home, ".claude/settings.local.json");
    mkdirSync(join(ctx.home, ".claude"), { recursive: true });
    writeFileSync(path, '{"outputStyle":"My Style","model":"sonnet"}\n');
    const [code] = await invoke(["setup", "--style", "standard", "--no-recommend"]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "sonnet" });
  });

  it("localizes every owned role file in --dir and keeps customized files on rerun", async () => {
    env();
    const dir = join(ctx.home, "my-handbook");
    expect((await invoke(["init", "--yes", "--lang", "zh", "--dir", dir]))[0]).toBe(0);
    for (const name of ["lead-boot", "worker-boot", "review-boot", "protocols"]) {
      expect(readFileSync(join(dir, `${name}.md`), "utf8")).toContain("请用中文");
    }
    expect(readFileSync(join(dir, "lead-boot.md"), "utf8")).not.toContain("# Lead boot");
    expect(readFileSync(join(dir, "setup-guide.md"), "utf8")).toContain("设置指南");
    const custom = join(dir, "lead-boot.md");
    writeFileSync(custom, readFileSync(custom, "utf8") + "\nMy edit.\n");
    const [code, out] = await invoke(["setup", "--lang", "en", "--no-recommend"]);
    expect(code).toBe(0);
    expect(out).toContain("kept customized");
    expect(readFileSync(custom, "utf8")).toContain("My edit.");
    expect(readFileSync(join(dir, "worker-boot.md"), "utf8")).not.toContain("请用中文");
  });

  it("anchors a relative handbook --dir for setup from another working directory", async () => {
    env();
    expect((await invoke(["init", "--yes", "--dir", "relative-book"]))[0]).toBe(0);
    const other = join(ctx.home, "other-project");
    mkdirSync(other);
    const previous = process.cwd();
    process.chdir(other);
    try {
      const code = await main(["setup", "--lang", "zh", "--no-recommend"], {
        out: () => {}, err: () => {}, stdin: () => "", isTTY: () => false,
      });
      expect(code).toBe(0);
    } finally { process.chdir(previous); }
    expect(readFileSync(join(ctx.home, "relative-book", "setup-guide.md"), "utf8")).toContain("设置指南");
    expect(existsSync(join(other, "relative-book"))).toBe(false);
  });
});
