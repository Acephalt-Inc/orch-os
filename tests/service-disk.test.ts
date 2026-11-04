import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Messages } from '../src/messages.js';
import { Workers } from '../src/workers.js';
import { recordWorkerOwnership } from '../src/worker-ownership.js';
import { Disk } from '../src/service/disk.js';
import { WakeWatch, snapshot } from '../src/service/wake.js';
import { useTmpHome } from './_helpers.js';
const ctx = useTmpHome();
const now = 2_000_000_000, old = now - 20 * 86400;
function fixture(platform: NodeJS.Platform = 'darwin') {
  const home = ctx.home, root = join(home, 'workers'), dir = join(root, 'w'), repo = join(home, 'repo');
  mkdirSync(dir, { recursive: true }); mkdirSync(repo);
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  expect(git(['-C', repo, 'init', '-b', 'main']).code).toBe(0);
  writeFileSync(join(repo, 'tracked'), 'original');
  expect(git(['-C', repo, 'add', 'tracked']).code).toBe(0);
  expect(git(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial']).code).toBe(0);
  const wt = new Workers({ workers: { worktree_root: join(home, 'worktrees') } }, root, join(home, 'load.json')).prepareWorktree('w', repo);
  const meta = { name: 'w', pid: 424242, started_at: old, workdir: wt.path, worktree: wt };
  writeFileSync(join(dir, 'worker.json'), JSON.stringify(meta)); writeFileSync(join(dir, 'stdout.log'), 'old output');
  recordWorkerOwnership(root, 'w', true, wt);
  for (const p of [join(dir, 'worker.json'), join(dir, 'stdout.log'), dir]) utimesSync(p, old, old);
  const messages = new Messages(join(home, 'messages.jsonl'), join(home, 'cursors'));
  let processes = platform === 'win32' ? '[]' : '';
  let probeCode = 0;
  const runner = (cmd: string, args: string[]) => cmd === 'git' ? git(args) : { code: probeCode, out: processes, err: 'probe unavailable' };
  const options = { home, root, messages, reader: 'lead', platform, runner, floorBytes: 100, staleDays: 7, mode: 'apply' as const, now: () => now, diskFree: () => 99 };
  return { home, root, dir, wt, meta, options, processes: (s: string, code = 0) => { processes = s; probeCode = code; }, run: (mode: 'apply' | 'dry-run' = 'apply', preview = false) => new Disk({ ...options, mode }).tick(preview) };
}
it('dry-run preserves all directories and apply removes only the verified candidate on macOS', () => {
  const f = fixture();
  expect(f.run('dry-run').directories).toEqual([{ path: f.dir, worktree: f.wt.path, action: 'WOULD_DELETE', reason: 'eligible' }]);
  expect(existsSync(f.dir)).toBe(true); expect(existsSync(f.wt.path)).toBe(true);
  expect(f.run().directories[0].action).toBe('DELETE');
  expect(existsSync(f.dir)).toBe(false); expect(existsSync(f.wt.path)).toBe(false);
});
it('explicit preview writes nothing even when config mode is apply', () => {
  const f = fixture();
  expect(f.run('apply', true).directories[0].action).toBe('WOULD_DELETE');
  expect(existsSync(join(f.home, 'wake'))).toBe(false); expect(existsSync(f.dir)).toBe(true);
});
it.each([
  ['unowned', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, '.ownership.json'))],
  ['attached', (f: ReturnType<typeof fixture>) => { f.meta.worktree.created = false; writeFileSync(join(f.dir, 'worker.json'), JSON.stringify(f.meta)); }],
  ['dirty', (f: ReturnType<typeof fixture>) => writeFileSync(join(f.wt.path, 'notes'), 'keep')],
  ['ignored', (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.wt.path, '.gitignore'), 'output\n'); writeFileSync(join(f.wt.path, 'output'), 'keep'); }],
  ['recent', (f: ReturnType<typeof fixture>) => utimesSync(join(f.dir, 'stdout.log'), now, now)],
  ['running', (f: ReturnType<typeof fixture>) => f.processes('424242 424242 S')],
  ['group', (f: ReturnType<typeof fixture>) => f.processes('999999 424242 S')],
  ['unknown-processes', (f: ReturnType<typeof fixture>) => f.processes('', 1)],
  ['invalid-processes', (f: ReturnType<typeof fixture>) => f.processes('unexpected response')],
  ['linked-metadata', (f: ReturnType<typeof fixture>) => { const p = join(f.dir, 'worker.json'); rmSync(p); symlinkSync(join(f.home, 'other'), p); }],
  ['replaced-directory', (f: ReturnType<typeof fixture>) => { rmSync(f.dir, { recursive: true }); mkdirSync(f.dir); writeFileSync(join(f.dir, 'worker.json'), JSON.stringify(f.meta)); }],
  ['foreign-worktree', (f: ReturnType<typeof fixture>) => { f.meta.worktree.path = f.wt.repo; writeFileSync(join(f.dir, 'worker.json'), JSON.stringify(f.meta)); }],
  ['invalid-metadata', (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, 'worker.json'), '{}')],
] as const)('preserves directories for refusal: %s', (_reason, mutate) => {
  const f = fixture(); mutate(f);
  const result = f.run();
  expect(result.directories[0]).toMatchObject({ action: 'KEEP', reason: expect.any(String) });
  expect(existsSync(f.dir)).toBe(true); expect(existsSync(f.wt.path)).toBe(true);
});
it('preserves an active Windows descendant', () => {
  const f = fixture('win32'); f.processes('[{"ProcessId":999999,"ParentProcessId":424242}]');
  expect(f.run().directories[0].action).toBe('KEEP');
});
it('rechecks processes immediately before apply', () => {
  const f = fixture(); let probes = 0;
  f.options.runner = (cmd, args) => {
    if (cmd === 'git') { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return { code: r.status ?? 1, out: r.stdout, err: r.stderr }; }
    return { code: 0, out: ++probes > 1 ? '424242 424242 S' : '', err: '' };
  };
  expect(f.run().directories[0].action).toBe('KEEP'); expect(existsSync(f.wt.path)).toBe(true);
});
const events = (home: string) => readFileSync(join(home, 'wake', 'events.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
it('alerts once per low-disk period across restart and interrupted cursor commits', () => {
  const f = fixture();
  f.run('dry-run'); f.run('dry-run');
  expect(events(f.home).filter(e => e.kind === 'LOW_DISK')).toHaveLength(1);
  const cursor = join(f.home, 'wake', 'cursor.json'); writeFileSync(cursor, '{"seq":0}');
  f.run('dry-run'); expect(events(f.home).filter(e => e.kind === 'LOW_DISK')).toHaveLength(1);
  new Disk({ ...f.options, mode: 'dry-run', diskFree: () => 100 }).tick();
  new WakeWatch(f.home, f.options.messages, 'lead', () => []).tick();
  const saved = readFileSync(cursor, 'utf8');
  f.run('dry-run'); writeFileSync(cursor, saved); f.run('dry-run');
  expect(events(f.home).filter(e => e.kind === 'LOW_DISK')).toHaveLength(2);
});
it('does not commit recovery ahead of the shared cursor', () => {
  const f = fixture(); f.run('dry-run');
  const watch = new WakeWatch(f.home, f.options.messages, 'lead', () => [], (p, data) => {
    if (p.endsWith('cursor.json')) throw new Error('interrupted'); snapshot(p, data);
  });
  expect(() => watch.tick(undefined, { low_disk: false })).toThrow('interrupted');
  f.run('dry-run'); expect(events(f.home).filter(e => e.kind === 'LOW_DISK')).toHaveLength(1);
});
it('recovers a logged period before a later recovery and new low-space period', () => {
  const f = fixture(); f.run('dry-run');
  const recovered = () => new Disk({ ...f.options, mode: 'dry-run', diskFree: () => 100 }).tick();
  recovered();
  const interrupted = new WakeWatch(f.home, f.options.messages, 'lead', () => [], (p, data) => {
    if (p.endsWith('cursor.json')) throw new Error('interrupted'); snapshot(p, data);
  });
  expect(() => interrupted.tick(undefined, { low_disk: true })).toThrow('interrupted');
  recovered(); f.run('dry-run');
  expect(events(f.home).filter(e => e.kind === 'LOW_DISK').map(e => e.id)).toEqual(['disk:lead:1', 'disk:lead:2', 'disk:lead:3']);
});
it('preserves a worktree locked by its repository owner', () => {
  const f = fixture();
  expect(spawnSync('git', ['-C', f.wt.repo, 'worktree', 'lock', f.wt.path]).status).toBe(0);
  expect(f.run().directories[0]).toMatchObject({ action: 'KEEP', reason: expect.stringContaining('removal refused') });
  expect(existsSync(f.dir)).toBe(true); expect(existsSync(f.wt.path)).toBe(true);
});
it('does not infer Windows orphan absence from a partial parent-PID snapshot', () => {
  const f = fixture('win32'); f.processes('[{"ProcessId":999998,"ParentProcessId":999999}]');
  expect(f.run()).toMatchObject({ outcome: 'UNAVAILABLE', directories: [{ action: 'KEEP', reason: expect.stringContaining('UNAVAILABLE') }] });
  expect(existsSync(f.wt.path)).toBe(true);
});

it.each(['--assume-unchanged', '--skip-worktree'])('preserves tracked changes hidden by %s', flag => {
  const f = fixture();
  expect(spawnSync('git', ['-C', f.wt.path, 'update-index', flag, 'tracked']).status).toBe(0);
  writeFileSync(join(f.wt.path, 'tracked'), 'valuable local change');
  expect(f.run().directories[0].action).toBe('KEEP');
  expect(readFileSync(join(f.wt.path, 'tracked'), 'utf8')).toBe('valuable local change');
});
it('preserves unrecorded worktrees, corrupt ownership, shared worktrees and unavailable Git evidence', () => {
  const f = fixture();
  const own = join(f.root, '.ownership.json'), original = readFileSync(own, 'utf8');
  writeFileSync(own, '{"owner":"user","workers":{}}');
  expect(f.run().directories[0].action).toBe('KEEP'); writeFileSync(own, original);
  const peer = join(f.root, 'peer'); mkdirSync(peer); writeFileSync(join(peer, 'worker.json'), JSON.stringify({ workdir: f.wt.path }));
  expect(f.run().directories.find((row: { path: string }) => row.path === f.dir).reason).toContain('shared worktree'); rmSync(peer, { recursive: true });
  const saved = f.options.runner;
  f.options.runner = (cmd, args) => cmd === 'git' ? { code: 1, out: '', err: 'unavailable' } : saved(cmd, args);
  expect(f.run().directories[0].reason).toContain('registration mismatch');
  expect(existsSync(f.wt.path)).toBe(true);
});
it('does not write optional Git state during an explicit preview', () => {
  const f = fixture(); const calls: string[][] = [], saved = f.options.runner;
  f.options.runner = (cmd, args) => { if (cmd === 'git') calls.push(args); return saved(cmd, args); };
  expect(f.run('apply', true).directories[0].action).toBe('WOULD_DELETE');
  expect(calls.length).toBeGreaterThan(0); expect(calls.every(args => args[0] === '--no-optional-locks')).toBe(true);
});
it('returns typed UNAVAILABLE when space cannot be measured or platform is unsupported', () => {
  const f = fixture();
  expect(new Disk({ ...f.options, diskFree: () => NaN }).tick()).toMatchObject({ outcome: 'UNAVAILABLE' });
  expect(new Disk({ ...f.options, platform: 'linux' }).tick()).toMatchObject({ outcome: 'UNAVAILABLE' });
  expect(existsSync(f.dir)).toBe(true); expect(existsSync(join(f.home, 'wake'))).toBe(false);
});
it('rejects corrupt disk cursor state without rewriting alerts', () => {
  const f = fixture(); f.run('dry-run'); const p = join(f.home, 'wake', 'events.log'), before = readFileSync(p, 'utf8');
  writeFileSync(join(f.home, 'wake', 'cursor.json'), '{"seq":0,"disk":"foreign","disk_period":-1}');
  expect(() => f.run('dry-run')).toThrow('invalid disk cursor'); expect(readFileSync(p, 'utf8')).toBe(before);
});
it('measures Windows free space with the injected DriveInfo adapter and reports failure', () => {
  const f = fixture('win32'); const calls: string[][] = [];
  const options = { ...f.options, home: "C:\\ORCH's data", diskFree: undefined,
    runner: (_cmd: string, args: string[]) => { calls.push(args); return { code: 0, out: '123\r\n', err: '' }; } };
  expect(new Disk(options).tick(true)).toMatchObject({ disk_free_bytes: 123, low_disk: false });
  expect(Buffer.from(calls[0][3], 'base64').toString('utf16le')).toContain("C:\\ORCH''s data");
  expect(Buffer.from(calls[0][3], 'base64').toString('utf16le')).toContain('AvailableFreeSpace');
  expect(new Disk({ ...options, runner: () => ({ code: 1, out: '', err: 'unavailable' }) }).tick(true).outcome).toBe('UNAVAILABLE');
});
it('keeps low-disk event identity stable when reader casing changes across restart', () => {
  const f = fixture(); f.run('dry-run');
  new Disk({ ...f.options, mode: 'dry-run', reader: 'LEAD' }).tick();
  expect(events(f.home).filter(e => e.kind === 'LOW_DISK')).toHaveLength(1);
});
