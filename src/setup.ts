// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Guided setup is additive: it never changes profile policy or removes user files. */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigError } from "./config.js";
import { HANDBOOK, TEMPLATE_DIR, targetFile, type Layout } from "./handbook.js";
import * as P from "./profile.js";
import { RECOMMENDATIONS, runRecommendations } from "./recommend.js";
import { parseToml, replaceTables, tableRanges, tomlValue } from "./toml.js";
import { atomicWrite, isPlainObject } from "./util.js";

export interface SetupIO {
  out(s: string): void;
  err(s: string): void;
  isTTY?(): boolean;
  ask?(q: string): string | null;
}

export type Language = "en" | "zh" | "other";
export type Level = "new" | "some" | "developer";
export type Style = "concise-tables" | "standard" | "skip";
export interface Answers { language: Language; people: P.People; level: Level; style: Style; skipStyle: boolean; applyStyle: boolean; explicitStandard: boolean; selected: number[] }
export interface SetupFlags {
  yes?: boolean; lang?: string; solo?: boolean; team?: boolean;
  level?: string; style?: string; no_recommend?: boolean;
}

function line(io: SetupIO, s: string): void { io.out(s + "\n"); }

function languageDefault(): Language {
  const raw = (process.env.LANG ?? "en").toLowerCase();
  return raw.startsWith("zh") ? "zh" : raw.startsWith("en") ? "en" : "other";
}

/** A separate table because [profile] has a strict policy schema. */
interface SetupState { language: Language; level: Level; style: Style; managed_style?: boolean; prior_output_style?: string; handbook_dir?: string; handbook_layout?: Layout }
export function readSetup(cfg: Record<string, any>): SetupState | null {
  const v = cfg.setup;
  if (v === undefined) return null;
  if (!isPlainObject(v)) throw new ConfigError("[setup] must be a table");
  for (const k of Object.keys(v)) if (!["language", "level", "style", "managed_style", "prior_output_style", "handbook_dir", "handbook_layout"].includes(k)) throw new ConfigError(`[setup] unknown key '${k}'`);
  if (!["en", "zh", "other"].includes(v.language)) throw new ConfigError("[setup] language must be en, zh, or other");
  if (!["new", "some", "developer"].includes(v.level)) throw new ConfigError("[setup] level must be new, some, or developer");
  if (!["concise-tables", "standard", "skip"].includes(v.style)) throw new ConfigError("[setup] style must be concise-tables, standard, or skip");
  if (v.managed_style !== undefined && typeof v.managed_style !== "boolean") throw new ConfigError("[setup] managed_style must be boolean");
  if (v.prior_output_style !== undefined && typeof v.prior_output_style !== "string") throw new ConfigError("[setup] prior_output_style must be a string");
  if (v.handbook_dir !== undefined && typeof v.handbook_dir !== "string") throw new ConfigError("[setup] handbook_dir must be a string");
  if (v.handbook_layout !== undefined && !["flat", "skills"].includes(v.handbook_layout)) throw new ConfigError("[setup] handbook_layout must be flat or skills");
  return v as SetupState;
}

function choose(io: SetupIO, number: number, prompt: string, def: string,
                choices: Record<string, string>, onExplicit?: (explicit: boolean) => void): string | null {
  for (let tries = 0; tries < 3; tries++) {
    const raw = io.ask!(`Question ${number}/6 — ${prompt} [default: ${def}] `);
    if (raw === null) return null;
    const key = raw.trim().toLowerCase();
    if (key === "") { onExplicit?.(false); return def; }
    if (Object.hasOwn(choices, key)) { onExplicit?.(true); return choices[key]; }
    line(io, `  choose ${Object.keys(choices).join(", ")}`);
  }
  return null;
}

function addOns(io: SetupIO): number[] | null {
  line(io, "Question 6/6 — Recommended add-ons (none by default; enter comma-separated numbers):");
  RECOMMENDATIONS.forEach((r, i) => line(io, `  ${i + 1}. ${r.name} — ${r.value} (${r.license}) ${r.url}`));
  for (let tries = 0; tries < 3; tries++) {
    const raw = io.ask!("Select [default: none] ");
    if (raw === null) return null;
    if (!raw.trim()) return [];
    const ids = raw.split(",").map((x) => Number(x.trim()));
    if (ids.every((x) => Number.isInteger(x) && x >= 1 && x <= RECOMMENDATIONS.length)) return [...new Set(ids.map((x) => x - 1))];
    line(io, `  choose numbers 1-${RECOMMENDATIONS.length}, separated by commas`);
  }
  return null;
}

/** null means the user cancelled or input ended; no files have been written yet. */
export function collect(flags: SetupFlags, io: SetupIO, found: string[], cfg: Record<string, any>): Answers | null {
  if (flags.solo && flags.team) throw new ConfigError("setup: --solo and --team are mutually exclusive");
  const old = readSetup(cfg);
  const profile = P.readProfile(cfg);
  const interactive = Boolean(io.isTTY?.() && io.ask && !flags.yes);
  const lang = (flags.lang ?? old?.language ?? languageDefault()) as Language;
  const people = (flags.team ? "team" : flags.solo ? "solo" : profile?.people ?? "solo") as P.People;
  const level = (flags.level ?? old?.level ?? "some") as Level;
  const style = (flags.style ?? old?.style ?? (level === "new" ? "concise-tables" : "standard")) as Style;
  let answerLang = lang, answerPeople = people, answerLevel = level, answerStyle = style;
  let skipStyle = flags.style === "skip";
  let styleRequested = Boolean(flags.style && flags.style !== "skip");
  let explicitStandard = flags.style === "standard";
  if (interactive) {
    if (!flags.lang) {
      const v = choose(io, 1, "Language for handbook and replies: en / zh / other?", lang, { en: "en", zh: "zh", other: "other" });
      if (v === null) return null;
      answerLang = v as Language;
    }
    if (!flags.solo && !flags.team) {
      const v = choose(io, 2, "Solo or team?", people, { solo: "solo", team: "team" });
      if (v === null) return null;
      answerPeople = v as P.People;
    }
    if (!flags.level) {
      const v = choose(io, 3, "Technical background: new / some / developer?", level, { new: "new", some: "some", developer: "developer" });
      if (v === null) return null;
      answerLevel = v as Level;
    }
    const detected = found.length ? found.join(", ") : "none";
    const confirm = choose(io, 4, `Agents found on PATH: ${detected}. Continue? yes / no`, "yes", { yes: "yes", no: "no", y: "yes", n: "no" });
    if (confirm !== "yes") return null;
    if (!flags.style) {
      const preferred = old?.style ?? (answerLevel === "new" ? "concise-tables" : "standard");
      let typed = false;
      const v = choose(io, 5, "Reply style: concise-tables / standard / skip?", preferred,
        { "concise-tables": "concise-tables", standard: "standard", skip: "skip" }, (explicit) => { typed = explicit; });
      if (v === null) return null;
      answerStyle = v as Style;
      skipStyle = v === "skip";
      styleRequested = typed || v !== old?.style;
      explicitStandard = typed && v === "standard";
    }
  }
  const selected = interactive && !flags.no_recommend ? addOns(io) : [];
  if (selected === null) return null;
  if (skipStyle && old) answerStyle = old.style;
  const applyStyle = !skipStyle && (!old || styleRequested || answerStyle !== old.style);
  return { language: answerLang, people: answerPeople, level: answerLevel, style: answerStyle, skipStyle, applyStyle, explicitStandard, selected };
}

/** A project-scoped setup must never treat the user's HOME as a project. */
export function isHomeProject(projectDir: string): boolean {
  const home = process.env.HOME || homedir();
  const physical = (path: string): string => {
    try { return realpathSync(path); }
    catch { return resolve(path); }
  };
  return physical(projectDir) === physical(home);
}

const STYLE_TEXT = `---\nname: orch-concise\ndescription: ORCH-os verdict-first replies with concise status tables\nkeep-coding-instructions: true\n---\n\n# ORCH-os concise tables\n\nStart with the verdict. Use tables for status, short lines, and a plain-language gloss when a term first appears. Keep the answer useful without assuming software expertise.\n`;
const AGENTS_SECTION = `<!-- ORCH-os concise tables -->\n## ORCH-os concise tables\n\nStart with the verdict. Use tables for status and short lines. Explain each technical term in plain language the first time it appears.\n<!-- /ORCH-os concise tables -->\n`;

function setupGuide(level: Level, language: Language): string {
  if (language === "zh") {
    const detail = level === "new" ? "先运行 `orch doctor`，逐项阅读 PASS 或 FAIL。worker 是执行编码任务的智能体；lease 是轮到谁担任负责人。接着按角色手册一步步操作。"
      : level === "some" ? "运行 `orch doctor`，再让每个智能体读取对应的角色手册。分配任务前检查共享信箱和当前 lease。"
      : "运行 `orch doctor`；使用生成的角色手册、共享信箱和 lease 命令作为操作参考。";
    return `# ORCH-os 设置指南\n\n${detail}\n`;
  }
  const detail = level === "new" ? "Start with `orch doctor` and read each PASS or FAIL. A worker is a coding agent; a lease is its turn to lead. Follow the generated role handbook one step at a time."
    : level === "some" ? "Run `orch doctor`, then point each agent to its generated role handbook. Check the mailbox and current lease before assigning work."
    : "Run `orch doctor`; use the generated role handbook, mailbox, and lease commands as your operational reference.";
  return `# ORCH-os setup guide\n\n${language === "other" ? "Full handbook translation is available for en and zh only; this is the English fallback.\n\n" : ""}${detail}\n`;
}

function writeOwnedFile(path: string, desired: string, previous: string[], io: SetupIO): void {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === desired) return;
    if (!previous.includes(current)) { line(io, `kept customized ${path}`); return; }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired);
  line(io, `wrote ${path}`);
}

/** Replace only the value token on the existing [profile] people line. */
function changePeople(text: string, people: P.People): string {
  const range = tableRanges(text, (name) => name.length === 1 && name[0] === "profile")[0];
  if (!range) throw new ConfigError("setup: [profile] has no editable people line");
  const [start, end] = range;
  const block = text.slice(start, end);
  const pattern = /^([ \t]*(?:people|"people"|'people')[ \t]*=[ \t]*)(["'])(?:solo|team)\2(?=[ \t]*(?:#.*)?(?:\r?\n|$))/m;
  if (!pattern.test(block)) throw new ConfigError("setup: [profile] people cannot be safely edited in place");
  const changed = block.replace(pattern, (_match, prefix: string, quote: string) => `${prefix}${quote}${people}${quote}`);
  return text.slice(0, start) + changed + text.slice(end);
}

/** The generated [setup] table is edited one value at a time so user comments survive. */
function updateSetup(text: string, values: Record<string, string | boolean | undefined>): string {
  const current = parseToml(text).setup ?? {};
  const range = tableRanges(text, (name) => name.length === 1 && name[0] === "setup")[0];
  if (!range) {
    const body = Object.entries(values).filter(([, v]) => v !== undefined)
      .map(([key, v]) => `${key} = ${typeof v === "boolean" ? v : tomlValue(v as string)}\n`).join("");
    return replaceTables(text, (name) => name[0] === "setup", `[setup]\n${body}`);
  }
  const [start, end] = range;
  let block = text.slice(start, end);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && Object.hasOwn(current, key) && current[key] === value) continue;
    const keyLine = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|true|false)([ \\t]*(?:#.*)?)(\\r?\\n|$)`, "m");
    const match = block.match(keyLine);
    if (value === undefined) {
      if (match) block = block.replace(keyLine, "");
      continue;
    }
    const encoded = typeof value === "boolean" ? String(value) : tomlValue(value);
    if (match) block = block.replace(keyLine, (_full, before: string, _old: string, after: string, ending: string) =>
      `${before}${encoded}${after}${ending}`);
    else {
      if (new RegExp(`^[ \\t]*${key}[ \\t]*=`, "m").test(block))
        throw new ConfigError(`setup: [setup] ${key} cannot be safely edited in place`);
      block += `${block.endsWith("\n") ? "" : "\n"}${key} = ${encoded}\n`;
    }
  }
  return text.slice(0, start) + block + text.slice(end);
}

function roleText(name: string, language: Language, level: Level): string {
  const source = language === "zh" ? new URL(`../templates/handbook-zh/${name}.md`, import.meta.url) : `${TEMPLATE_DIR}${name}.md`;
  const base = readFileSync(source, "utf8");
  if (language === "en" && level === "some") return base;
  const languageLine = language === "zh" ? "请用中文回复用户；以下英文命令和安全规则仍是准确的操作依据。"
    : language === "other" ? "Reply in the user's chosen language; keep the commands and safety rules below intact."
    : "Reply in English; keep the commands and safety rules below intact.";
  const detail = level === "new" ? (language === "zh" ? "先解释术语，再按步骤执行。" : "Explain each term before following the steps.")
    : level === "developer" ? (language === "zh" ? "简要报告结果与失败。" : "Report results and failures briefly.") : "";
  const preface = `\n> ORCH-os setup: ${languageLine}${detail ? ` ${detail}` : ""}\n`;
  return base.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, `$1${preface}`);
}

function settingsAt(projectDir: string): string { return join(projectDir, ".claude", "settings.local.json"); }
function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(value)) throw new Error("not a JSON object");
    if (value.outputStyle !== undefined && typeof value.outputStyle !== "string") throw new Error("outputStyle must be a string");
    return value;
  } catch (e) {
    throw new ConfigError(`setup: ${path} is not valid JSON settings (${e instanceof Error ? e.message : String(e)}); nothing written`);
  }
}

function changeAgents(style: "concise-tables" | "standard", projectDir: string, io: SetupIO): void {
  const path = join(projectDir, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (style === "concise-tables") {
    if (existing.includes("<!-- ORCH-os concise tables -->")) return;
    writeFileSync(path, existing + (existing ? "\n\n" : "") + AGENTS_SECTION);
    line(io, `wrote ${path}`);
  } else {
    const suffix = existing === AGENTS_SECTION ? AGENTS_SECTION : `\n\n${AGENTS_SECTION}`;
    if (existing.endsWith(suffix)) {
      writeFileSync(path, existing.slice(0, -suffix.length));
      line(io, `removed ORCH-os section from ${path}`);
    } else if (existing.includes("<!-- ORCH-os concise tables -->")) line(io, `kept customized ${path}; remove the ORCH-os section manually if desired`);
  }
}

/** Profile is changed only at people; account/agent mappings and all other tables survive. */
export function apply(answer: Answers, io: SetupIO, configPath: string, found: string[],
                      projectDir = process.cwd(), writeGuide = true,
                      handbookDir = join(dirname(configPath), "handbook"), layout: Layout = "flat"): void {
  if (isHomeProject(projectDir)) throw new ConfigError("setup: run from a project directory, not HOME; no files written");
  const original = readFileSync(configPath, "utf8");
  const cfg = parseToml(original);
  const old = readSetup(cfg);
  const profile = P.readProfile(cfg);
  const actualDir = handbookDir;
  const actualLayout = layout;

  // Preflight project settings before changing config or any file.
  const settingsPath = settingsAt(projectDir);
  let settings: Record<string, any> | null = null;
  let managed = old?.managed_style ?? false;
  let prior = old?.prior_output_style;
  if (answer.applyStyle && answer.style === "concise-tables") {
    const stylePath = join(projectDir, ".claude", "output-styles", "orch-concise.md");
    if (existsSync(stylePath) && readFileSync(stylePath, "utf8") !== STYLE_TEXT)
      throw new ConfigError(`setup: ${stylePath} was customized; no files written`);
    settings = readSettings(settingsPath);
    if (!managed) prior = typeof settings.outputStyle === "string" && settings.outputStyle !== "orch-concise" ? settings.outputStyle : undefined;
    settings.outputStyle = "orch-concise";
    managed = true;
  } else if (answer.applyStyle && answer.style === "standard" && answer.explicitStandard) {
    const current = readSettings(settingsPath);
    if (current.outputStyle !== undefined) {
      delete current.outputStyle; // explicit standard selects Claude's documented Default style
      settings = current;
    }
    managed = false;
    prior = undefined;
  }

  let next = original;
  if (!profile) next = P.writeProfileText(next, P.initialProfile("one", answer.people, found));
  else if (profile.people !== answer.people) next = changePeople(next, answer.people);
  if (!old || old.language !== answer.language || old.level !== answer.level || old.style !== answer.style ||
      old.managed_style !== managed || old.prior_output_style !== prior || old.handbook_dir !== actualDir || old.handbook_layout !== actualLayout) {
    next = updateSetup(next, {
      language: answer.language, level: answer.level, style: answer.style,
      managed_style: managed, handbook_dir: actualDir, handbook_layout: actualLayout,
      prior_output_style: prior,
    });
  }
  // Validate the two tables before replacing the file. Existing unrelated tables remain untouched.
  const checked = parseToml(next);
  P.readProfile(checked);
  readSetup(checked);
  if (next !== original) {
    atomicWrite(configPath, next, { mode: statSync(configPath).mode & 0o777 });
    line(io, `updated setup in ${configPath}`);
  } else line(io, `setup unchanged: ${configPath}`);

  if (writeGuide) {
    const guide = join(actualDir, "setup-guide.md");
    const priorGuides = (["en", "zh", "other"] as Language[]).flatMap((language) =>
      (["new", "some", "developer"] as Level[]).map((level) => setupGuide(level, language)));
    writeOwnedFile(guide, setupGuide(answer.level, answer.language), priorGuides, io);
    for (const name of HANDBOOK) {
      const file = targetFile(actualDir, name, actualLayout);
      const variants = (["en", "zh", "other"] as Language[]).flatMap((language) =>
        (["new", "some", "developer"] as Level[]).map((level) => roleText(name, language, level)));
      writeOwnedFile(file, roleText(name, answer.language, answer.level), variants, io);
    }
  }
  if (answer.language === "other") line(io, "full handbook translation is available for en and zh only; using the English fallback for other locales");
  if (answer.applyStyle && answer.style === "concise-tables") {
    const stylePath = join(projectDir, ".claude", "output-styles", "orch-concise.md");
    writeOwnedFile(stylePath, STYLE_TEXT, [], io);
  }
  if (settings !== null) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const output = JSON.stringify(settings, null, 2) + "\n";
    const existed = existsSync(settingsPath);
    if (!existed || readFileSync(settingsPath, "utf8") !== output) {
      atomicWrite(settingsPath, output, existed ? { mode: statSync(settingsPath).mode & 0o777 } : {});
      line(io, `${existed ? "updated" : "wrote"} ${settingsPath}`);
    }
  }
  if (answer.applyStyle && answer.style !== "skip" && (answer.style === "concise-tables" || old?.managed_style))
    changeAgents(answer.style, projectDir, io);
  if (answer.people === "team" && !(profile?.teammates.length))
    line(io, "team setup needs teammate accounts/GitHub approval configuration before doctor can pass; no teammate was invented.");
  runRecommendations(answer.selected, (s) => line(io, s));
}
