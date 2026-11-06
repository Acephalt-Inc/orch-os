import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { HOOK_CONTRACT, runHook, SESSION_START, PRE_TOOL_USE, STOP } from '../src/host/hooks.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-hook-')); roots.push(root);
  const workspace = join(root, 'workspace'); const home = join(root, 'home');
  mkdirSync(workspace); mkdirSync(home);
  return { root, workspace, home };
}
function context(workspace: string, tasks: unknown[], stop_reason?: string) {
  mkdirSync(join(workspace, '.orch'), { recursive: true });
  writeFileSync(join(workspace, '.orch', 'host-context.json'), JSON.stringify({ tasks, ...(stop_reason === undefined ? {} : { stop_reason }) }));
}
function call(command: string, workspace: string, event: Record<string, unknown>, home?: string) {
  let out = '', err = '';
  const code = runHook([command, '--workspace', workspace], { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => JSON.stringify(event) }, { home });
  return { code, out, err };
}
const task = { id: 'A-1', approved: true, status: 'in_progress' };

describe('Claude hook event contract', () => {
  it('exports exact event names and ignores malformed or mismatched input', () => {
    expect([SESSION_START, PRE_TOOL_USE, STOP]).toEqual(['SessionStart', 'PreToolUse', 'Stop']);
    expect(HOOK_CONTRACT).toEqual({
      events: ['SessionStart', 'PreToolUse', 'Stop'],
      inputFields: ['session_id', 'cwd', 'hook_event_name', 'tool_name', 'tool_input', 'stop_hook_active', 'transcript_path'],
      refusalExit: 2, stopDecision: 'block', continueExit: 0, sessionMaxLines: 40, stopCap: 1,
    });
    const { workspace } = fixture(); context(workspace, [task]);
    expect(call('stop-continue', workspace, { hook_event_name: PRE_TOOL_USE, session_id: 's' }).code).toBe(0);
    let out = '', err = '';
    expect(runHook(['stop-continue', '--workspace', workspace], { out: s => { out += s; }, err: s => { err += s; }, stdin: () => '{bad' })).toBe(0);
    expect(out).toBe(''); expect(err).toBe('');
  });

  it('shows bounded, labelled task, index, and private resume data at session start', () => {
    const { workspace, home } = fixture();
    context(workspace, [{ id: 'A-1', approved: true, status: 'in_progress', stop_reason: 'wait for review' }, { id: 'B-2', approved: false, status: 'open' }], 'pause rollout');
    mkdirSync(join(workspace, 'workspace-notes', 'shared'), { recursive: true });
    writeFileSync(join(workspace, 'workspace-notes', 'shared', 'INDEX.md'), '# Index\n' + 'data line\n'.repeat(100));
    const digest = createHash('sha256').update(workspace).digest('hex');
    const resumeDir = join(home, '.orch-private', 'resume-v1', digest); mkdirSync(resumeDir, { recursive: true });
    writeFileSync(join(resumeDir, 'state.json'), JSON.stringify({ schema: 1, id: 'note-1', revision: 1, saved_at: '2026-01-01', note: { objective: 'ship', next_step: 'verify', reported_progress: 'built' } }));
    const result = call('session-start', workspace, { hook_event_name: SESSION_START, session_id: 's', cwd: workspace, transcript_path: join(workspace, 'transcript.jsonl') }, home);
    expect(result.code).toBe(0);
    expect(result.out.split('\n').filter(Boolean).length).toBeLessThanOrEqual(40);
    expect(result.out).toContain('unverified'); expect(result.out).toContain('A-1'); expect(result.out).toContain('pause rollout');
    expect(result.out).toContain('Index'); expect(result.out).toContain('ship');
  });

  it('starts with useful headings when all data is absent', () => {
    const { workspace, home } = fixture();
    const result = call('session-start', workspace, { hook_event_name: SESSION_START, session_id: 's' }, home);
    expect(result.code).toBe(0); expect(result.out).toContain('Tasks'); expect(result.out).toContain('Memory');
  });

  it('blocks only one approved active task once per session across fresh calls', () => {
    const { workspace } = fixture(); context(workspace, [task]);
    const event = { hook_event_name: STOP, session_id: 'session/../one', cwd: workspace, stop_hook_active: false };
    const first = call('stop-continue', workspace, event);
    expect(first.code).toBe(0); expect(first.err).toBe(''); expect(JSON.parse(first.out)).toEqual({ decision: 'block', reason: 'continue A-1' });
    expect(call('stop-continue', workspace, event).out).toBe('');
    const names = readdirSync(join(workspace, '.orch', 'host-sessions'));
    expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[a-f0-9]{64}\.stop$/);
  });

  it('respects host loop guard, recorded stop reasons, approval, and missing state', () => {
    const { workspace } = fixture(); const event = { hook_event_name: STOP, session_id: 's' };
    expect(call('stop-continue', workspace, event).out).toBe('');
    for (const tasks of [[], [{ ...task, approved: false }], [{ ...task, status: 'done' }], [{ ...task, stop_reason: 'done for now' }]]) {
      context(workspace, tasks); expect(call('stop-continue', workspace, event).out).toBe('');
    }
    context(workspace, [task], 'explicit stop'); expect(call('stop-continue', workspace, event).out).toBe('');
    context(workspace, [task], ''); expect(call('stop-continue', workspace, event).out).toBe('');
    context(workspace, [task]); expect(call('stop-continue', workspace, { ...event, stop_hook_active: true }).out).toBe('');
    expect(call('stop-continue', workspace, { hook_event_name: STOP }).out).toBe('');
  });

  it('fails open for corrupt context and unsafe state ancestor', () => {
    const { workspace, root } = fixture();
    mkdirSync(join(workspace, '.orch')); writeFileSync(join(workspace, '.orch', 'host-context.json'), '{');
    expect(call('stop-continue', workspace, { hook_event_name: STOP, session_id: 's' }).out).toBe('');
    rmSync(join(workspace, '.orch'), { recursive: true });
    const target = join(root, 'elsewhere'); mkdirSync(target); symlinkSync(target, join(workspace, '.orch'));
    expect(call('stop-continue', workspace, { hook_event_name: STOP, session_id: 's' }).out).toBe('');
    expect(readdirSync(target)).toEqual([]);
  });

  it('guards foreground waits and lets bounded or background commands run', () => {
    const { workspace } = fixture();
    const guard = (tool_name: string, command: string, run_in_background = false) => call('pre-tool-guard', workspace, { hook_event_name: PRE_TOOL_USE, session_id: 's', tool_name, tool_input: { command, run_in_background } });
    for (const command of ['sleep 31', 'sleep 31 # wait', 'sleep 31 > wait.log', 'sleep 20 20', 'sleep 1d', 'echo ok; sleep 2m', 'gh run watch 123', 'timeout 0 gh run watch 123', 'watch date', 'tail -F log', 'Get-Content log -Wait', 'Start-Sleep 31', 'Start-Sleep -Seconds 31', 'Start-Sleep -Milliseconds 31000']) {
      const result = guard(command.startsWith('Get-') || command.startsWith('Start-') ? 'PowerShell' : 'Bash', command);
      expect(result.code, command).toBe(2); expect(result.out, command).toBe(''); expect(result.err, command).toContain('poll or use a background watcher');
    }
    for (const command of ['sleep 30', 'timeout 30s gh run watch 123', 'sleep 31 &', 'sleep 60 & echo done', 'echo timeout; gh run watch 123']) {
      const result = guard('Bash', command);
      expect(result.code, command).toBe(command.startsWith('echo timeout') ? 2 : 0);
    }
    expect(guard('Bash', 'gh run watch 123', true).code).toBe(0);
    expect(guard('Read', 'sleep 99').code).toBe(0);
    let err = '';
    expect(runHook(['pre-tool-guard'], { out: () => {}, err: s => { err += s; }, stdin: () => JSON.stringify({ hook_event_name: PRE_TOOL_USE, tool_name: 'Bash', tool_input: { command: 'sleep 31' } }) })).toBe(2);
    expect(err).toContain('poll or use a background watcher');
  });

  it('accepts Windows event paths without opening a transcript', () => {
    const { workspace } = fixture(); context(workspace, [task]);
    const result = call('stop-continue', workspace, { hook_event_name: STOP, session_id: 'windows', cwd: 'C:\\work\\repo', transcript_path: 'C:\\work\\session.jsonl' });
    expect(result.code).toBe(0); expect(JSON.parse(result.out).reason).toBe('continue A-1');
  });

  it('uses injected Windows path flavor for read-only session context', () => {
    const workspace = 'C:\\work\\repo', home = 'C:\\Users\\operator';
    const reads = new Map<string, string>([
      [win32.join(workspace, '.orch', 'host-context.json'), JSON.stringify({ tasks: [task] })],
      [win32.join(workspace, 'workspace-notes', 'shared', 'INDEX.md'), '# Windows index'],
    ]);
    let out = '';
    const code = runHook(['session-start'], { out: s => { out += s; }, err: () => {}, stdin: () => JSON.stringify({ hook_event_name: SESSION_START, cwd: workspace, transcript_path: 'C:\\temp\\trace.jsonl' }) },
      { platform: 'win32', path: win32, home, read: file => reads.get(file) });
    expect(code).toBe(0); expect(out).toContain('A-1'); expect(out).toContain('Windows index');
    out = '';
    expect(runHook(['session-start'], { out: s => { out += s; }, err: () => {}, stdin: () => JSON.stringify({ hook_event_name: STOP, cwd: workspace }) },
      { platform: 'win32', home, read: file => reads.get(file) })).toBe(0);
    expect(out).toBe('');
    expect(runHook(['session-start'], { out: s => { out += s; }, err: () => {}, stdin: () => JSON.stringify({ hook_event_name: SESSION_START }) },
      { platform: 'win32', home, read: file => reads.get(file) })).toBe(0);
    expect(out).toBe('');
  });

  it('uses Windows storage paths and an exclusive marker across invocations', () => {
    const workspace = 'C:\\work\\repo';
    const dirs = new Set(['C:\\work', workspace, win32.join(workspace, '.orch')]); const markers = new Set<string>();
    const fs = {
      lstat: (file: string) => { if (!dirs.has(file)) throw Error('missing'); return { isDirectory: () => true, isSymbolicLink: () => false }; },
      mkdir: (file: string) => { if (dirs.has(file)) throw Object.assign(Error('exists'), { code: 'EEXIST' }); dirs.add(file); },
      createExclusive: (file: string) => { if (markers.has(file)) throw Object.assign(Error('exists'), { code: 'EEXIST' }); markers.add(file); },
    };
    const deps = { platform: 'win32' as const, home: 'C:\\Users\\operator', fs,
      read: (file: string) => file === win32.join(workspace, '.orch', 'host-context.json') ? JSON.stringify({ tasks: [task] }) : undefined };
    const event = { hook_event_name: STOP, cwd: workspace, transcript_path: 'C:\\temp\\trace.jsonl', session_id: 'win-session' };
    const run = () => { let out = ''; const code = runHook(['stop-continue'], { out: s => { out += s; }, err: () => {}, stdin: () => JSON.stringify(event) }, deps); return { out, code }; };
    expect(JSON.parse(run().out)).toEqual({ decision: 'block', reason: 'continue A-1' });
    expect(run().out).toBe('');
    expect([...markers]).toEqual([win32.join(workspace, '.orch', 'host-sessions', `${createHash('sha256').update('win-session').digest('hex')}.stop`)]);
  });

  it('reports hook usage without reading stdin, and rejects unknown command forms', () => {
    let out = '', err = '', reads = 0;
    const io = { out: (s: string) => { out += s; }, err: (s: string) => { err += s; }, stdin: () => { reads++; return ''; } };
    expect(runHook(['--help'], io)).toBe(0); expect(out).toContain('orch hook'); expect(reads).toBe(0);
    expect(runHook(['session-start', '--help'], io)).toBe(0); expect(reads).toBe(0);
    expect(runHook(['unknown'], io)).toBe(2); expect(err).toContain('orch hook');
    expect(runHook(['session-start', '--bad'], io)).toBe(2);
  });
});
