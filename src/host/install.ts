// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import * as nodeFs from 'node:fs';
import nodePath, { type PlatformPath } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, HelpRequested, UsageError, type CmdSpec } from '../args.js';

type IO = { out: (s: string) => void; err: (s: string) => void };
type Deps = { home?: string; platform?: NodeJS.Platform; path?: PlatformPath; fs?: typeof nodeFs };
type Obj = Record<string, any>;
const block = '<!-- orch-host:start -->\nContinue when no decision is needed.\nGive status and the next action in the same message.\nAsk before irreversible or outward-facing actions, including merges, pushes to shared branches, payments, sending messages, or deleting data.\nGive evidence before saying work is done.\n<!-- orch-host:end -->';
const events = [['SessionStart', 'session-start'], ['PreToolUse', 'pre-tool-guard'], ['Stop', 'stop-continue']] as const;
const common = ['Bash(git status)', 'Bash(git diff)', 'Bash(git log)', 'Bash(pwd)'];
const presets: Record<string, string[]> = {
  coding: [...common, 'Read', 'Grep', 'Glob', 'Bash(npm test)'],
  research: [...common, 'Read', 'Grep', 'Glob', 'Bash(ls)', 'Bash(cat README.md)'],
  ops: [...common, 'Read', 'Grep', 'Glob', 'Bash(ls)'],
};
const opt = (dest: string, flag: string, kind: 'str' | 'bool', choices?: string[]) => ({ dest, flags: [flag], kind, help: dest, choices });
export function hostSpec(): CmdSpec<any> {
  const opts = [opt('workspace', '--workspace', 'str'), opt('host', '--host', 'str', ['claude']), opt('preset', '--preset', 'str', Object.keys(presets)), opt('scope', '--scope', 'str', ['workspace', 'user']), opt('dry', '--dry-run', 'bool')];
  return { name: 'host', help: 'install, inspect, or remove Claude host settings', sub: ['install', 'status', 'uninstall'].map(name => ({ name, help: `${name} host integration`, opts })) };
}
export function hostLocations(workspace: string, home: string, scope: string, path: PlatformPath = nodePath) {
  return { settings: path.join(scope === 'user' ? home : workspace, '.claude', 'settings.json'), agreement: path.join(workspace, 'CLAUDE.md'), state: path.join(scope === 'user' ? home : workspace, `.orch-host-${scope}`) };
}
const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameActivation = (a: Obj, b: Obj) => { const { hooks: _a, ...left } = a; const { hooks: _b, ...right } = b; return same(left, right); };
function shape(s: unknown): asserts s is Obj {
  if (!object(s) || (s.permissions !== undefined && !object(s.permissions)) || (s.permissions?.allow !== undefined && (!Array.isArray(s.permissions.allow) || !s.permissions.allow.every((v: unknown) => typeof v === 'string'))) || (s.hooks !== undefined && !object(s.hooks))) throw Error('invalid settings shape');
  for (const value of Object.values(s.hooks ?? {})) {
    if (!Array.isArray(value) || !value.every(group => object(group) && Array.isArray(group.hooks) && group.hooks.every(object))) throw Error('invalid hooks shape');
  }
}
function checkPath(fs: typeof nodeFs, path: PlatformPath, target: string, directory = false): void {
  let p = path.resolve(target); const parts: string[] = [];
  for (;;) { parts.push(p); const parent = path.dirname(p); if (parent === p) break; p = parent; }
  for (const item of parts.reverse()) {
    try { const st = fs.lstatSync(item); if (st.isSymbolicLink() || (item === target && !directory ? !st.isFile() : !st.isDirectory())) throw Error(`unsafe path: ${item}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
function read(fs: typeof nodeFs, path: PlatformPath, name: string): string | null {
  checkPath(fs, path, name);
  try { return fs.readFileSync(name, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
function hook(name: string, workspace: string, scope: string) {
  return { type: 'command', command: 'node', args: [fileURLToPath(new URL('../cli.js', import.meta.url)), 'hook', name, ...(scope === 'workspace' ? ['--workspace', workspace] : [])], timeout: 5 };
}
function group(event: string, name: string, workspace: string, scope: string) {
  return { ...(event === 'PreToolUse' ? { matcher: 'Bash|PowerShell' } : {}), hooks: [hook(name, workspace, scope)] };
}
export async function runHost(argv: string[], io: IO, deps: Deps = {}): Promise<number> {
  const fs = deps.fs ?? nodeFs, path = deps.path ?? (deps.platform === 'win32' ? nodePath.win32 : nodePath);
  let lock: string | null = null;
  try {
    const { args, cmd } = parse(hostSpec(), argv, ['orch', 'host']);
    if (!args.workspace || !args.host) throw new UsageError('--workspace and --host are required', 'orch host');
    const workspace = path.resolve(args.workspace), scope = args.scope ?? 'workspace', preset = args.preset ?? 'coding';
    checkPath(fs, path, workspace, true);
    if (!fs.lstatSync(workspace).isDirectory()) throw Error('workspace must exist');
    const loc = hostLocations(workspace, deps.home ?? homedir(), scope, path);
    const statePath = path.join(loc.state, 'manifest.json'), ignorePath = path.join(loc.state, '.gitignore');
    const raw = read(fs, path, loc.settings), agreement = read(fs, path, loc.agreement), stateRaw = read(fs, path, statePath);
    const settings: Obj = raw === null ? {} : JSON.parse(raw); shape(settings);
    const state = stateRaw === null ? null : JSON.parse(stateRaw);
    if (state !== null && (!object(state) || state.version !== 1 || state.workspace !== workspace || state.scope !== scope || !Array.isArray(state.allow) || !Array.isArray(state.required) || !state.required.every((v: unknown) => typeof v === 'string') || !Array.isArray(state.groups) || typeof state.installed !== 'string' || !(state.before === null || typeof state.before === 'string') || !(state.agreementBefore === null || typeof state.agreementBefore === 'string') || typeof state.agreementInstalled !== 'string')) throw Error('invalid ownership record');
    const status = () => {
      let ready = state?.agreementPending !== false;
      for (const item of state?.required ?? presets[preset]) { const present = !!settings.permissions?.allow?.includes(item); ready &&= present; io.out(`permission ${item}: ${present ? 'INSTALLED' : 'MISSING'}\n`); }
      for (const [event, name] of events) {
        const wanted = state?.groups?.find((g: Obj) => g.event === event)?.value ?? group(event, name, workspace, scope);
        const list = settings.hooks?.[event] ?? [];
        const exact = list.some((g: Obj) => same(g, wanted));
        const present = list.some((g: Obj) => sameActivation(g, wanted) && g.hooks.some((h: Obj) => same(h, wanted.hooks[0])));
        ready &&= exact || present;
        const changed = list.some((g: Obj) => g.hooks.some((h: Obj) => Array.isArray(h.args) && h.args.includes(name)));
        io.out(`hook ${name}: ${exact || present ? 'INSTALLED' : changed ? 'MODIFIED-BY-USER' : 'MISSING'}\n`);
      }
      const agreementPresent = !!agreement?.includes(block); ready &&= agreementPresent;
      io.out(`agreement: ${agreementPresent ? 'INSTALLED' : agreement?.includes('<!-- orch-host:') ? 'MODIFIED-BY-USER' : 'MISSING'}\n`);
      return ready;
    };
    if (cmd.name === 'status') { status(); return 0; }
    if (cmd.name === 'install') {
      if (state) { if (status()) return 0; io.out('Incomplete install: run uninstall, then install again.\n'); return 2; }
      if (agreement?.includes('<!-- orch-host:start -->') || agreement?.includes('<!-- orch-host:end -->')) throw Error('agreement ownership collision');
      const allow = presets[preset].filter(item => !settings.permissions?.allow?.includes(item));
      const groups = events.map(([event, name]) => ({ event, value: group(event, name, workspace, scope) })).filter(({ event, value }) => !(settings.hooks?.[event] ?? []).some((g: Obj) => sameActivation(g, value) && g.hooks.some((h: Obj) => same(h, value.hooks[0]))));
      const merged = structuredClone(settings); merged.permissions ??= {}; merged.permissions.allow ??= []; merged.permissions.allow.push(...allow); merged.hooks ??= {};
      for (const { event, value } of groups) { merged.hooks[event] ??= []; merged.hooks[event].push(value); }
      const installed = JSON.stringify(merged, null, 2) + '\n';
      const agreementInstalled = (agreement ?? '') + (agreement && !agreement.endsWith('\n') ? '\n' : '') + (agreement ? '\n' : '') + block + '\n';
      io.out(`install ${loc.settings} and ${loc.agreement}${args.dry ? ' (dry run)' : ''}\n`);
      if (args.dry) return 0;
      { const candidate = path.join(workspace, '.orch-host-lock'); checkPath(fs, path, candidate, true); fs.mkdirSync(candidate); lock = candidate; }
      checkPath(fs, path, path.dirname(loc.settings), true); checkPath(fs, path, loc.state, true);
      fs.mkdirSync(loc.state, { mode: 0o700 });
      fs.writeFileSync(ignorePath, '*\n', { flag: 'wx', mode: 0o600 });
      const record = { version: 1, workspace, scope, before: raw, installed, agreementBefore: agreement, agreementInstalled, agreementPending: true, required: presets[preset], allow, groups };
      fs.writeFileSync(statePath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      fs.mkdirSync(path.dirname(loc.settings), { recursive: true });
      if (read(fs, path, loc.settings) !== raw || read(fs, path, loc.agreement) !== agreement) throw Error('file changed during install');
      fs.writeFileSync(loc.settings, installed); fs.writeFileSync(loc.agreement, agreementInstalled);
      return 0;
    }
    if (!state) { io.out('MISSING ownership record\n'); return 0; }
    status();
    if (args.dry) { io.out('dry run: no changes\n'); return 0; }
    { const candidate = path.join(workspace, '.orch-host-lock'); checkPath(fs, path, candidate, true); fs.mkdirSync(candidate); lock = candidate; }
    if (read(fs, path, loc.settings) !== raw || read(fs, path, loc.agreement) !== agreement || read(fs, path, statePath) !== stateRaw) throw Error('file changed during uninstall');
    let modified = false;
    const remainingGroups: Obj[] = []; let remainingAgreement = false;
    if (raw === state.installed) { if (state.before === null) fs.unlinkSync(loc.settings); else fs.writeFileSync(loc.settings, state.before); }
    else if (raw !== null) {
      const merged = structuredClone(settings);
      for (const item of state.allow) { const index = merged.permissions?.allow?.indexOf(item) ?? -1; if (index >= 0) merged.permissions.allow.splice(index, 1); }
      for (const { event, value } of state.groups) {
        const list = merged.hooks?.[event] ?? []; const index = list.findIndex((g: Obj) => same(g, value));
        if (index >= 0) list.splice(index, 1); else { const owner = list.find((g: Obj) => sameActivation(g, value) && g.hooks.some((h: Obj) => same(h, value.hooks[0]))); if (owner) owner.hooks = owner.hooks.filter((h: Obj) => !same(h, value.hooks[0])); else if (list.some((g: Obj) => g.hooks.some((h: Obj) => Array.isArray(h.args) && h.args.includes(value.hooks[0].args[2])))) { modified = true; remainingGroups.push({ event, value }); } }
      }
      const before: Obj = state.before === null ? {} : JSON.parse(state.before);
      if (merged.permissions?.allow?.length === 0 && before.permissions?.allow === undefined) delete merged.permissions.allow;
      if (merged.permissions && Object.keys(merged.permissions).length === 0 && before.permissions === undefined) delete merged.permissions;
      for (const [event] of events) if (merged.hooks?.[event]?.length === 0 && before.hooks?.[event] === undefined) delete merged.hooks[event];
      if (merged.hooks && Object.keys(merged.hooks).length === 0 && before.hooks === undefined) delete merged.hooks;
      if (state.before === null && Object.keys(merged).length === 0) fs.unlinkSync(loc.settings);
      else fs.writeFileSync(loc.settings, JSON.stringify(merged, null, 2) + '\n');
    }
    if (state.agreementPending === false) { /* this agreement is no longer owned */ }
    else if (agreement === state.agreementInstalled) { if (state.agreementBefore === null) fs.unlinkSync(loc.agreement); else fs.writeFileSync(loc.agreement, state.agreementBefore); }
    else if (agreement && agreement.startsWith(state.agreementInstalled) && state.agreementInstalled) {
      fs.writeFileSync(loc.agreement, (state.agreementBefore ?? '') + agreement.slice(state.agreementInstalled.length));
    }
    else if (agreement?.includes(block)) {
      fs.writeFileSync(loc.agreement, agreement.replace(block, ''));
    }
    else if (agreement?.includes('<!-- orch-host:')) { modified = true; remainingAgreement = true; }
    const ignore = read(fs, path, ignorePath);
    if (ignore !== null && ignore !== '*\n') modified = true;
    if (!modified) { if (ignore !== null) fs.unlinkSync(ignorePath); fs.unlinkSync(statePath); fs.rmdirSync(loc.state); }
    else {
      // Retain backups and only unresolved modified items; removed entries are no longer ours.
      state.allow = []; state.groups = remainingGroups; state.installed = '';
      state.agreementPending = remainingAgreement;
      fs.writeFileSync(statePath, JSON.stringify(state));
      io.out('MODIFIED-BY-USER: ownership record retained\n');
    }
    return modified ? 2 : 0;
  } catch (e) {
    if (e instanceof HelpRequested) { io.out(e.text + '\n'); return 0; }
    io.err(`orch host: ${e instanceof Error ? e.message : String(e)}\n`); return e instanceof UsageError ? 2 : 1;
  } finally { if (lock) { try { fs.rmdirSync(lock); } catch {} } }
}
