// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** The non-engineering, no-Git setup path. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Args } from "./args.js";
import * as C from "./config.js";
import type { IO } from "./cli.js";
import * as D from "./detect.js";
import { Mailbox } from "./mailbox.js";
import { parseToml } from "./toml.js";

const TEMPLATE = fileURLToPath(new URL("../templates/handbook/everyday.md", import.meta.url));
const BEGIN = "<!-- orch-os everyday: begin -->";
const END = "<!-- orch-os everyday: end -->";

export function lfText(text: string): string { return text.replace(/\r\n?/g, "\n"); }

function fail(io: IO, text: string): number { io.err(text + "\n"); return 2; }

/** Handle `init --everyday`; validation is complete before the first write. */
export function everydayInit(a: Args, io: IO): number {
  const conflicts = ["force", "no_handbook", "compute", "people", "policy", "required_review", "max_workers"]
    .filter((k) => a[k] !== null && a[k] !== undefined && a[k] !== false);
  if (conflicts.length) return fail(io, `init: --everyday cannot be combined with --${conflicts[0].replaceAll("_", "-")}`);
  const home = C.orchHome();
  const config = C.configPath();
  let configText: string | null = null;
  if (existsSync(config)) {
    configText = readFileSync(config, "utf8");
    let parsed: Record<string, any>;
    try { parsed = parseToml(configText); }
    catch { return fail(io, `init: existing config is not in everyday mode; fix it and add mode = "everyday" by hand, or use another ORCH_HOME`); }
    if (parsed.orch?.mode !== "everyday") return fail(io, `init: existing config is not in everyday mode; add mode = "everyday" by hand, or use another ORCH_HOME`);
  }
  const dir = a.dir ? C.expand(a.dir) : join(home, "handbook");
  const handbook = a.layout === "skills" ? join(dir, "everyday", "SKILL.md") : join(dir, "everyday.md");
  if (/\r|\n/.test(handbook)) return fail(io, "init: the everyday handbook path must not contain a line break");
  const agentFile = join(process.cwd(), "CLAUDE.md");
  let oldAgent: string | null = null;
  const agentStat = !a.no_agent_file ? lstatSync(agentFile, { throwIfNoEntry: false }) : undefined;
  if (agentStat) {
    if (!agentStat.isFile()) return fail(io, "init: CLAUDE.md must be a regular file");
    oldAgent = readFileSync(agentFile, "utf8");
    if ((oldAgent.split(BEGIN).length - 1) > (oldAgent.split(END).length - 1))
      return fail(io, "init: CLAUDE.md has an everyday begin line without an end line");
  }
  const block = `${BEGIN}\nAt the start of every session, read \`${handbook}\` and follow it.\n${END}`;
  let newAgent = oldAgent;
  if (!a.no_agent_file) {
    if (oldAgent?.includes(BEGIN)) {
      let first = true;
      newAgent = oldAgent.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`, "g"), () => { if (first) { first = false; return block; } return ""; });
    } else newAgent = oldAgent === null || oldAgent.length === 0 ? block + "\n" : oldAgent + (oldAgent.endsWith("\n") ? "" : "\n") + block + "\n";
  }
  mkdirSync(home, { recursive: true });
  if (configText === null) {
    const agents = D.installed();
    configText = C.renderDefault(home, agents, agents[0]?.name, "everyday");
    if (a.dir) configText = configText.replace(`dir = ${JSON.stringify(join(home, "handbook"))}`, `dir = ${JSON.stringify(dir)}`);
    writeFileSync(config, configText); io.out(`wrote ${config}\n`);
  } else io.out(`config exists: ${config} (unchanged)\n`);
  const cfg = parseToml(configText);
  const mc = cfg.mailbox ?? {};
  const mb = new Mailbox(C.expand(mc.path ?? join(home, "mailbox.md")), mc.sections ?? ["LEAD", "WORKER", "REVIEWER", "SYSTEM"]);
  if (!existsSync(mb.path)) { mkdirSync(dirname(mb.path), { recursive: true }); writeFileSync(mb.path, mb.skeleton()); io.out(`wrote ${mb.path}\n`); }
  if (!existsSync(handbook) || a.force_handbook) {
    mkdirSync(dirname(handbook), { recursive: true });
    writeFileSync(handbook, lfText(readFileSync(TEMPLATE, "utf8")));
    io.out(`wrote ${handbook}\n`);
  }
  if (!a.no_agent_file && newAgent !== oldAgent) writeFileSync(agentFile, newAgent!);
  io.out(`handbook: ${handbook}\nnext: orch doctor\n`);
  return 0;
}

/** Apply the mode-specific interpretation after doctor has collected its normal rows. */
export function everydayDoctorRows(rows: [string, string, string][], cfg: Record<string, any> | null, dir: string): void {
  const mode = cfg?.orch?.mode;
  if (mode !== undefined && mode !== "everyday") { rows.push(["FAIL", "mode", `unknown mode ${JSON.stringify(mode)}`]); return; }
  if (mode !== "everyday") return;
  const handbook = [join(dir, "everyday.md"), join(dir, "everyday", "SKILL.md")].find(existsSync);
  for (const row of rows) {
    if (row[1] === "handbook") row.splice(0, 3, handbook ? "PASS" : "SKIP", "handbook", handbook ?? `${dir} - run \`orch init --everyday\``);
    if (row[1] === "git" && row[0] === "FAIL") row.splice(0, 3, "SKIP", "git", "not needed in everyday mode");
    if (row[1] === "gh (merge-gate live mode)" && row[0] === "SKIP") row[2] = "not needed in everyday mode";
    if (row[1] === "merge repo" && row[0] === "SKIP") row[2] = "not needed in everyday mode";
  }
}
