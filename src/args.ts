// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * A small argparse-style parser (no dependency): nested subcommands, positionals (optional,
 * variadic, with choices), options with typed values, `--opt=value`, `-n5`, `--` and -h.
 * Usage errors raise UsageError; the CLI prints them argparse-style and exits 2.
 */

export type Kind = "bool" | "str" | "int" | "float";

export interface OptSpec {
  dest: string;
  flags: string[];
  kind: Kind;
  help: string;
  metavar?: string;
  choices?: string[];
}

export interface PosSpec {
  dest: string;
  help?: string;
  optional?: boolean;
  variadic?: boolean;
  choices?: string[];
}

export interface CmdSpec<R = unknown> {
  name: string;
  help: string;
  usage?: string;
  pos?: PosSpec[];
  opts?: OptSpec[];
  sub?: CmdSpec<R>[];
  run?: R;
}

export type Args = Record<string, any> & { _path: string[] };

export class UsageError extends Error {
  constructor(msg: string, readonly usage: string) {
    super(msg);
    this.name = "UsageError";
  }
}

export class HelpRequested extends Error {
  constructor(readonly text: string) {
    super("help");
    this.name = "HelpRequested";
  }
}

export function usageOf(spec: CmdSpec<any>, path: string[]): string {
  if (spec.usage) return `usage: ${spec.usage}`;
  const head = path.join(" ");
  if (spec.sub) return `usage: ${head} {${spec.sub.map((s) => s.name).join(",")}} ...`;
  const opts = (spec.opts ?? []).map((o) => `[${o.flags[0]}${o.kind === "bool" ? "" : " " + (o.metavar ?? o.dest.toUpperCase())}]`);
  const pos = (spec.pos ?? []).map((p) => {
    const n = p.choices ? `{${p.choices.join(",")}}` : p.dest.toUpperCase();
    return p.variadic ? `[${n} ...]` : p.optional ? `[${n}]` : n;
  });
  return `usage: ${[head, ...opts, ...pos].join(" ")}`;
}

export function helpOf(spec: CmdSpec<any>, path: string[]): string {
  const lines = [usageOf(spec, path), "", spec.help];
  if (spec.sub) {
    lines.push("", "commands:");
    for (const s of spec.sub) lines.push(`  ${s.name.padEnd(12)} ${s.help}`);
  }
  if (spec.pos?.length) {
    lines.push("", "positional arguments:");
    for (const p of spec.pos) lines.push(`  ${p.dest.padEnd(20)} ${p.help ?? (p.choices ? p.choices.join(" | ") : "")}`);
  }
  if (spec.opts?.length) {
    lines.push("", "options:");
    for (const o of spec.opts) {
      const f = o.flags.join(", ") + (o.kind === "bool" ? "" : " " + (o.metavar ?? o.dest.toUpperCase()));
      lines.push(`  ${f.padEnd(28)} ${o.help}`);
    }
  }
  return lines.join("\n");
}

function convert(o: OptSpec, raw: string, usage: string): any {
  if (o.kind === "int") {
    if (!/^[+-]?\d+$/.test(raw.trim())) throw new UsageError(`argument ${o.flags.join("/")}: invalid int value: '${raw}'`, usage);
    return parseInt(raw, 10);
  }
  if (o.kind === "float") {
    const v = Number(raw);
    if (raw.trim() === "" || Number.isNaN(v)) throw new UsageError(`argument ${o.flags.join("/")}: invalid float value: '${raw}'`, usage);
    return v;
  }
  if (o.choices && !o.choices.includes(raw)) {
    throw new UsageError(`argument ${o.flags.join("/")}: invalid choice: '${raw}' (choose from ${o.choices.map((c) => `'${c}'`).join(", ")})`, usage);
  }
  return raw;
}

export function parse<R>(spec: CmdSpec<R>, argv: string[], path: string[] = [spec.name]): { args: Args; cmd: CmdSpec<R> } {
  const usage = usageOf(spec, path);
  if (spec.sub) {
    const [first, ...rest] = argv;
    if (first === "-h" || first === "--help") throw new HelpRequested(helpOf(spec, path));
    if (first === undefined) throw new UsageError("the following arguments are required: command", usage);
    const sub = spec.sub.find((s) => s.name === first);
    if (!sub) throw new UsageError(`argument command: invalid choice: '${first}' (choose from ${spec.sub.map((s) => `'${s.name}'`).join(", ")})`, usage);
    const r = parse(sub, rest, [...path, first]);
    return r;
  }
  const args: Args = { _path: path };
  const opts = spec.opts ?? [];
  for (const o of opts) args[o.dest] = o.kind === "bool" ? false : null;
  const pos: string[] = [];
  let onlyPos = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (onlyPos) {
      pos.push(t);
      continue;
    }
    if (t === "--") {
      onlyPos = true;
      continue;
    }
    if (t === "-h" || t === "--help") throw new HelpRequested(helpOf(spec, path));
    if (t.startsWith("-") && t.length > 1 && !/^-\d/.test(t)) {
      let flag = t;
      let inline: string | undefined;
      if (t.startsWith("--") && t.includes("=")) {
        flag = t.slice(0, t.indexOf("="));
        inline = t.slice(t.indexOf("=") + 1);
      } else if (!t.startsWith("--") && t.length > 2) {
        flag = t.slice(0, 2);
        inline = t.slice(2);
      }
      const o = opts.find((x) => x.flags.includes(flag));
      if (!o) throw new UsageError(`unrecognized arguments: ${t}`, usage);
      if (o.kind === "bool") {
        if (inline !== undefined) throw new UsageError(`argument ${o.flags.join("/")}: ignored explicit argument '${inline}'`, usage);
        args[o.dest] = true;
        continue;
      }
      let raw = inline;
      if (raw === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`argument ${o.flags.join("/")}: expected one argument`, usage);
        raw = argv[++i];
      }
      args[o.dest] = convert(o, raw, usage);
      continue;
    }
    pos.push(t);
  }
  const ps = spec.pos ?? [];
  let k = 0;
  for (const p of ps) {
    if (p.variadic) {
      args[p.dest] = pos.slice(k);
      k = pos.length;
      continue;
    }
    if (k < pos.length) {
      const v = pos[k++];
      if (p.choices && !p.choices.includes(v)) {
        throw new UsageError(`argument ${p.dest}: invalid choice: '${v}' (choose from ${p.choices.map((c) => `'${c}'`).join(", ")})`, usage);
      }
      args[p.dest] = v;
    } else if (p.optional) {
      args[p.dest] = null;
    } else {
      const missing = ps.slice(ps.indexOf(p)).filter((x) => !x.optional && !x.variadic).map((x) => x.dest);
      throw new UsageError(`the following arguments are required: ${missing.join(", ")}`, usage);
    }
  }
  if (k < pos.length) throw new UsageError(`unrecognized arguments: ${pos.slice(k).join(" ")}`, usage);
  return { args, cmd: spec };
}
