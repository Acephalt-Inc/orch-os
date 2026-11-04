// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Claude hook stdin is JSON: session_id, cwd, hook_event_name, and event-specific fields. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { type PlatformPath } from 'node:path';
import { parseRecord } from '../resume/schema.js';

export const SESSION_START = 'SessionStart';
export const PRE_TOOL_USE = 'PreToolUse';
export const STOP = 'Stop';
export const HOOK_CONTRACT = {
  events: [SESSION_START, PRE_TOOL_USE, STOP],
  inputFields: ['session_id', 'cwd', 'hook_event_name', 'tool_name', 'tool_input', 'stop_hook_active', 'transcript_path'],
  refusalExit: 2, stopDecision: 'block', continueExit: 0, sessionMaxLines: 40, stopCap: 1,
} as const;
export interface HookIO { out(text: string): void; err(text: string): void; stdin(): string; }
export interface HookFS {
  lstat(file: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  mkdir(file: string): void;
  createExclusive(file: string): void;
}
export interface HookDeps { platform?: NodeJS.Platform; path?: PlatformPath; home?: string; read?: (file: string, limit: number) => Buffer | string | undefined; fs?: HookFS; }
interface HostTask { id: string; approved: boolean; status: 'open' | 'in_progress' | 'done'; stop_reason?: string; }
interface HostContext { tasks: HostTask[]; stop_reason?: string; }
const EVENTS: Record<string, string> = { 'session-start': SESSION_START, 'pre-tool-guard': PRE_TOOL_USE, 'stop-continue': STOP };
const REASON = 'poll or use a background watcher';
export function hookSpec(): string { return 'orch hook session-start|pre-tool-guard|stop-continue [--workspace PATH]\nReads a Claude hook event as JSON on stdin.\n'; }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function oneLine(value: string, max = 180): string { return value.replace(/[\r\n\x00-\x1f]+/g, ' ').slice(0, max); }
function noLinks(file: string, p: PlatformPath, includeFile: boolean, stat: HookFS['lstat'] = lstatSync): boolean {
  const target = includeFile ? file : p.dirname(file); let at = p.parse(target).root;
  for (const part of target.slice(at.length).split(p.sep).filter(Boolean)) {
    at = p.join(at, part);
    try { if (stat(at).isSymbolicLink()) return false; } catch { return false; }
  }
  return true;
}
function safeRead(file: string, limit: number, p: PlatformPath, deps: HookDeps): Buffer | undefined {
  try {
    if (deps.read) { const value = deps.read(file, limit); if (value === undefined) return; const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return bytes.length <= limit ? bytes : undefined; }
    if (!noLinks(file, p, true, deps.fs?.lstat)) return;
    const stat = lstatSync(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) return;
    const fd = openSync(file, constants.O_RDONLY | (deps.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try { const opened = fstatSync(fd); if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit) return; return readFileSync(fd); }
    finally { closeSync(fd); }
  } catch { return; }
}
function readContext(workspace: string, p: PlatformPath, deps: HookDeps): HostContext | undefined {
  const bytes = safeRead(p.join(workspace, '.orch', 'host-context.json'), 32_768, p, deps); if (!bytes) return;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8')); if (!object(value) || !Array.isArray(value.tasks) || value.tasks.length > 100) return;
    if (value.stop_reason !== undefined && (typeof value.stop_reason !== 'string' || !value.stop_reason)) return;
    const tasks: HostTask[] = [];
    for (const row of value.tasks) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || row.id.length > 120 || typeof row.approved !== 'boolean' || !['open', 'in_progress', 'done'].includes(String(row.status)) || (row.stop_reason !== undefined && (typeof row.stop_reason !== 'string' || !row.stop_reason))) return;
      tasks.push(row as unknown as HostTask);
    }
    return { tasks, ...(value.stop_reason === undefined ? {} : { stop_reason: value.stop_reason }) };
  } catch { return; }
}
function createExclusive(file: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
  try { writeFileSync(fd, '1\n'); } finally { closeSync(fd); }
}
function claimStop(workspace: string, session: string, p: PlatformPath, deps: HookDeps): boolean {
  const state = p.join(workspace, '.orch'); const directory = p.join(state, 'host-sessions');
  try {
    const stat = deps.fs?.lstat ?? lstatSync;
    if (!noLinks(state, p, true, stat) || !stat(state).isDirectory()) return false;
    try { deps.fs ? deps.fs.mkdir(directory) : mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false; }
    if (!noLinks(directory, p, true, stat) || !stat(directory).isDirectory()) return false;
    const marker = p.join(directory, `${createHash('sha256').update(session).digest('hex')}.stop`);
    (deps.fs?.createExclusive ?? createExclusive)(marker);
    return true;
  } catch { return false; }
}
function sessionStart(workspace: string, p: PlatformPath, deps: HookDeps, io: HookIO): void {
  const lines = ['Tasks (unverified workspace data):']; const context = readContext(workspace, p, deps);
  if (!context || context.tasks.length === 0) lines.push('  none recorded');
  else for (const task of context.tasks.filter(t => t.status !== 'done').slice(0, 12)) lines.push(`  ${oneLine(task.id)}: ${task.status}, ${task.approved ? 'approved' : 'unapproved'}${task.stop_reason ? `; stop: ${oneLine(task.stop_reason)}` : ''}`);
  if (context?.stop_reason) lines.push(`  Global stop: ${oneLine(context.stop_reason)}`);
  lines.push('Memory index (unverified workspace data):');
  const index = safeRead(p.join(workspace, 'workspace-notes', 'shared', 'INDEX.md'), 8_192, p, deps);
  lines.push(...(index ? index.toString('utf8').split(/\r?\n/).filter(Boolean).slice(0, 12).map(s => `  ${oneLine(s)}`) : ['  none recorded']));
  lines.push('Private resume (unverified user data):');
  const home = deps.home ?? homedir();
  const digest = createHash('sha256').update(workspace).digest('hex');
  const resume = safeRead(p.join(home, '.orch-private', 'resume-v1', digest, 'state.json'), 4_096, p, deps);
  if (resume) {
    try { const note = parseRecord(resume).note; if (note) for (const key of ['objective', 'next_step', 'reported_progress'] as const) lines.push(`  ${key}: ${oneLine(note[key])}`); }
    catch { /* Stored private note is optional. */ }
  }
  if (lines[lines.length - 1] === 'Private resume (unverified user data):') lines.push('  none recorded');
  io.out(lines.slice(0, HOOK_CONTRACT.sessionMaxLines).join('\n') + '\n');
}
function duration(text: string): number { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(text); return m ? Number(m[1]) * ({ ms: .001, s: 1, m: 60, h: 3600, d: 86400 }[m[2]?.toLowerCase() as 'ms' | 's' | 'm' | 'h' | 'd' ?? 's']) : NaN; }
/** Deliberately small command recognizer, not a shell parser. */
function longForeground(command: string): boolean {
  const pieces = command.split(/(\r?\n|;|&&|\|\||(?<!&)\&(?!&)|(?<!\|)\|(?!\|))/);
  for (let i = 0; i < pieces.length; i += 2) {
    let part = pieces[i].trim(); if (!part || pieces[i + 1] === '&') continue;
    const bound = /^(?:timeout|gtimeout)\s+(\S+)\s+/i.exec(part); const bounded = bound && duration(bound[1]) > 0 && duration(bound[1]) <= 30;
    if (bound) part = part.slice(bound[0].length);
    if (bounded) continue;
    const sleep = /^sleep\s+(.+)$/i.exec(part);
    if (sleep) { let total = 0; for (const arg of sleep[1].trim().split(/\s+/)) { const seconds = duration(arg); if (!Number.isFinite(seconds)) break; total += seconds; } if (total > 30) return true; }
    const ps = /\bStart-Sleep\s+(?:-(Seconds|Milliseconds)\s+)?(\d+(?:\.\d+)?)/i.exec(part);
    if (ps && Number(ps[2]) * (ps[1]?.toLowerCase() === 'milliseconds' ? .001 : 1) > 30) return true;
    if (/^(?:gh\s+run\s+watch|watch\b)/i.test(part) || /^tail\b[^\n]*\s-(?:[a-z]*[fF]|-follow)\b/i.test(part) || /\bGet-Content\b[^\n]*\s-Wait\b/i.test(part)) return true;
  }
  return false;
}
export function runHook(argv: string[], io: HookIO, deps: HookDeps = {}): number {
  const eventName = EVENTS[argv[0]];
  if ((argv.length === 1 && ['-h', '--help'].includes(argv[0])) || (eventName && argv.length === 2 && ['-h', '--help'].includes(argv[1]))) { io.out(hookSpec()); return 0; }
  if (!eventName || !(argv.length === 1 || (argv.length === 3 && argv[1] === '--workspace' && argv[2]))) { io.err(hookSpec()); return 2; }
  let event: unknown; try { const raw = io.stdin(); if (Buffer.byteLength(raw) > 64_000) return 0; event = JSON.parse(raw); } catch { return 0; }
  if (!object(event) || event.hook_event_name !== eventName) return 0;
  if (eventName === PRE_TOOL_USE) {
    if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return 0;
    if (!object(event.tool_input) || typeof event.tool_input.command !== 'string' || event.tool_input.run_in_background === true) return 0;
    if (longForeground(event.tool_input.command)) { io.err(`${REASON}\n`); return HOOK_CONTRACT.refusalExit; }
    return 0;
  }
  const p = deps.path ?? (deps.platform === 'win32' ? path.win32 : deps.platform === 'darwin' ? path.posix : path);
  const option = argv.indexOf('--workspace');
  const given = option >= 0 ? argv[option + 1] : event.cwd;
  if (typeof given !== 'string' || !given || given.includes('\0')) return 0;
  let workspace: string;
  try { workspace = deps.read ? p.resolve(given) : realpathSync(p.resolve(given)); } catch { return 0; }
  if (eventName === SESSION_START) { sessionStart(workspace, p, deps, io); return 0; }
  if (event.stop_hook_active === true || typeof event.session_id !== 'string' || !event.session_id || event.session_id.length > 512) return 0;
  const context = readContext(workspace, p, deps); if (!context || context.stop_reason) return 0;
  const task = context.tasks.find(t => t.approved === true && t.status === 'in_progress' && !t.stop_reason);
  if (!task || !claimStop(workspace, event.session_id, p, deps)) return 0;
  io.out(JSON.stringify({ decision: HOOK_CONTRACT.stopDecision, reason: `continue ${oneLine(task.id, 120)}` }) + '\n'); return HOOK_CONTRACT.continueExit;
}
