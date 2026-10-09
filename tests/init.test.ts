// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HANDBOOK, TEMPLATE_DIR } from "../src/handbook.js";
import { parseToml } from "../src/toml.js";
import * as C from "../src/config.js";
import { run, useTmpHome } from "./_helpers.js";

describe("InitHandbookV2", () => {
  const ctx = useTmpHome();

  it("init_writes_the_four_handbook_files_flat", async () => {
    const [code, out] = await run("init");
    expect(code).toBe(0);
    for (const n of HANDBOOK) {
      const f = `${ctx.home}/handbook/${n}.md`;
      expect(out).toContain(`wrote ${f}`);
      expect(readFileSync(f, "utf8").replace(/\r\n?/g, "\n")).toBe(readFileSync(`${TEMPLATE_DIR}${n}.md`, "utf8").replace(/\r\n?/g, "\n"));
    }
    expect(HANDBOOK).toEqual(["lead-boot", "worker-boot", "review-boot", "protocols"]);
    const [dcode, dout] = await run("doctor");
    expect(dcode).toBe(0);
    expect(dout).toMatch(/PASS {2}handbook/);
  });

  it("skills_layout_and_custom_dir", async () => {
    const dir = `${ctx.home}/skills`;
    expect((await run("init", "--dir", dir, "--layout", "skills"))[0]).toBe(0);
    for (const n of HANDBOOK) {
      const text = readFileSync(`${dir}/${n}/SKILL.md`, "utf8").replace(/\r\n?/g, "\n");
      expect(text.startsWith(`---\nname: ${n}\ndescription: `)).toBe(true);
    }
    expect((await run("init", "--layout", "nested"))[0]).toBe(2);
  });

  it("existing_handbook_files_are_kept_unless_forced", async () => {
    await run("init");
    const f = `${ctx.home}/handbook/protocols.md`;
    writeFileSync(f, "my edits");
    let [, out] = await run("init", "--force");
    expect(out).toContain("kept 4 existing handbook file(s)");
    expect(readFileSync(f, "utf8")).toBe("my edits");
    [, out] = await run("init", "--force-handbook");
    expect(readFileSync(f, "utf8")).not.toBe("my edits");
    expect((await run("init", "--no-handbook"))[1]).not.toContain("handbook");
  });

  it("every_template_has_frontmatter_and_names_the_orch_commands_it_uses", () => {
    for (const n of HANDBOOK) {
      const t = readFileSync(`${TEMPLATE_DIR}${n}.md`, "utf8").replace(/\r\n?/g, "\n");
      expect(t).toMatch(new RegExp(`^---\\nname: ${n}\\ndescription: .+\\n---\\n`));
    }
    const protocols = readFileSync(`${TEMPLATE_DIR}protocols.md`, "utf8").replace(/\r\n?/g, "\n");
    for (const k of ["QUESTION", "ANSWER", "DONE", "BLOCKED", "orch task claim", "orch merge-gate", "current head commit", "not the author"]) {
      expect(protocols).toContain(k);
    }
  });

  it("a_v1_config_without_the_new_tables_still_works", async () => {
    // the v1.1 default config: no [messages], [tasks], [mem], [handbook] or worktree keys
    const v1 = C.renderDefault(ctx.home).replace(/\n\[messages\][\s\S]*?\n\[merge\]/, "\n[merge]").replace(/# `orch worker start NAME --worktree`[\s\S]*?worktree_branch_prefix = "orch\/"\n/, "");
    expect(parseToml(v1)).not.toHaveProperty("messages");
    writeFileSync(`${ctx.home}/config.toml`, v1);
    expect((await run("msg", "send", "DONE", "--as", "w1", "--to", "lead", "-m", "x"))[0]).toBe(0);
    expect((await run("task", "claim", "t", "--as", "w1"))[0]).toBe(0);
    expect((await run("mem", "add", "n", "-d", "d"))[0]).toBe(0);
    expect(existsSync(`${ctx.home}/messages.jsonl`)).toBe(true);
    expect(existsSync(`${ctx.home}/tasks/t.json`)).toBe(true);
    expect(existsSync(`${ctx.home}/mem/n.md`)).toBe(true);
  });

  it("config_prints_resolved_json", async () => {
    await run("init", "--no-handbook");
    const [code, out] = await run("config");
    expect(code).toBe(0);
    const [head, ...rest] = out.split("\n");
    expect(head).toBe(`# resolved from ${ctx.home}/config.toml`);
    expect(JSON.parse(rest.join("\n")).lease.min_seconds).toBe(60);
  });
});
