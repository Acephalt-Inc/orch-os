import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Awake, awakeSpec, type AwakeRunner } from '../src/service/awake.js';
import { tmp } from './_helpers.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup(platform: NodeJS.Platform = 'darwin') {
  const home = tmp(); roots.push(home);
  let live: { start: string; identity: string } | null = null;
  const calls: unknown[] = [];
  const runner: AwakeRunner = {
    start(command, args) { calls.push(['start', command, args]); live = { start: 'start1', identity: [command, ...args].join(' ') }; return { pid: 123, ...live }; },
    inspect(pid) { calls.push(['inspect', pid]); return live; },
    stop(pid) { calls.push(['stop', pid]); live = null; return true; },
  };
  return { home, calls, runner, awake: new Awake({ home, platform, runner, now: () => new Date(2026, 10, 3, 12, 0, 0) }), replace: () => { live = { start: 'other', identity: 'foreign' }; } };
}
describe('awake', () => {
  it.each(['darwin', 'win32'] as const)('starts, reports and stops an owned process on %s', platform => {
    const { awake, calls } = setup(platform);
    expect(awake.on({ hours: 2 }).outcome).toBe('ON');
    expect(calls[0]).toEqual(['start', ...Object.values(awakeSpec(platform, 7200))]);
    expect(awake.status()).toMatchObject({ outcome: 'STATUS', active: true, deadline: new Date(2026, 10, 3, 14, 0, 0).toISOString() });
    expect(awake.off().outcome).toBe('OFF');
    expect(calls).toContainEqual(['stop', 123]);
    expect(awake.status()).toMatchObject({ outcome: 'STATUS', active: false });
  });
  it('preserves a reused PID and the ownership record', () => {
    const { awake, replace, calls, home } = setup(); awake.on({ hours: 1 }); replace();
    expect(awake.off().outcome).toBe('CONFLICT');
    expect(calls).not.toContainEqual(['stop', 123]);
    expect(readFileSync(join(home, 'service', 'awake.json'), 'utf8')).toContain('start1');
  });
  it('validates and computes deadlines, including next-day clock time', () => {
    const { awake, calls } = setup();
    expect(awake.on({ hours: 0 }).outcome).toBe('ERROR');
    expect(awake.on({ until: '25:00' }).outcome).toBe('ERROR');
    expect(awake.on({ hours: 1, until: '13:00' }).outcome).toBe('ERROR');
    expect(awake.on({ until: '11:00' }).outcome).toBe('ON');
    expect((calls[0] as unknown[])[2]).toContain('82800');
  });
  it('never writes during dry run and reports unsupported platforms', () => {
    const { awake, calls } = setup(); expect(awake.on({ hours: 1, dryRun: true }).outcome).toBe('DRY_RUN');
    expect(calls).toEqual([]); expect(setup('linux').awake.on({ hours: 1 }).outcome).toBe('UNAVAILABLE');
  });
  it('preserves foreign records and symbolic links', () => {
    const { awake, home, calls } = setup(); mkdirSync(join(home, 'service'));
    const record = join(home, 'service', 'awake.json'); writeFileSync(record, 'user data');
    expect(awake.on({ hours: 1 }).outcome).toBe('CONFLICT'); expect(readFileSync(record, 'utf8')).toBe('user data');
    rmSync(record); symlinkSync(join(home, 'missing'), record);
    expect(awake.on({ hours: 1 }).outcome).toBe('CONFLICT'); expect(calls).toEqual([]);
  });
  it('preserves the record when stop fails or exit is unverified', () => {
    const { awake, runner, home } = setup(); awake.on({ hours: 1 });
    runner.stop = () => false;
    expect(awake.off()).toMatchObject({ outcome: 'ERROR', reason: 'Unable to stop awake process' });
    runner.stop = () => true;
    expect(awake.off()).toMatchObject({ outcome: 'ERROR', reason: 'Awake process exit could not be verified' });
    expect(readFileSync(join(home, 'service', 'awake.json'), 'utf8')).toContain('start1');
  });
  it('preserves the record when inspection fails and reports failed launches', () => {
    const first = setup(); first.awake.on({ hours: 1 });
    first.runner.inspect = () => { throw new Error('probe denied'); };
    expect(first.awake.off()).toMatchObject({ outcome: 'ERROR', reason: expect.stringContaining('probe denied') });
    expect(readFileSync(join(first.home, 'service', 'awake.json'), 'utf8')).toContain('start1');
    const second = setup(); second.runner.start = () => { throw new Error('launch failed'); };
    expect(second.awake.on({ hours: 1 })).toMatchObject({ outcome: 'ERROR', reason: expect.stringContaining('launch failed') });
  });
  it('stops the verified child if ownership creation fails', () => {
    const { awake, runner, home, calls } = setup(); const start = runner.start;
    runner.start = (command, args) => { const result = start(command, args); writeFileSync(join(home, 'service', 'awake.json'), 'foreign'); return result; };
    expect(awake.on({ hours: 1 })).toMatchObject({ outcome: 'ERROR', reason: expect.stringContaining('PID 123') });
    expect(calls).toContainEqual(['stop', 123]);
    expect(readFileSync(join(home, 'service', 'awake.json'), 'utf8')).toBe('foreign');
  });

  it('rejects a schema-valid foreign record without inspecting or stopping its process', () => {
    const { awake, home, calls } = setup(); mkdirSync(join(home, 'service'));
    writeFileSync(join(home, 'service', 'awake.json'), JSON.stringify({ version: 1, platform: 'darwin', pid: 123, start: 'start1', identity: 'other-app', owner: 'orch-awake-v1', home, seconds: 7200, deadline: new Date(2026, 10, 3, 14).toISOString() }));
    expect(awake.off().outcome).toBe('CONFLICT');
    expect(calls).toEqual([]);
  });

  it('encodes unsigned Windows execution-state flags and the requested deadline', () => {
    const spec = awakeSpec('win32', 7200);
    const script = Buffer.from(spec.args[spec.args.length - 1], 'base64').toString('utf16le');
    expect(script).toContain('SetThreadExecutionState([uint32]2147483649)');
    expect(script).toContain('Start-Sleep -Seconds 7200');
    expect(script).toContain('SetThreadExecutionState([uint32]2147483648)');
  });

});
