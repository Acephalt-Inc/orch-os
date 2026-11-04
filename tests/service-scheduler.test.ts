// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Scheduler, type Runner } from '../src/service/scheduler.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(platform: NodeJS.Platform, runner: Runner) {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-')); dirs.push(root);
  return { root, scheduler: new Scheduler({ platform, home: join(root, 'orch home'), userHome: root, node: '/node path', cli: '/cli path', uid: 501, user: 'user', runner }) };
}
it('reports Linux unavailable and dry run does not write or invoke the runner', () => {
  const runner: Runner = () => { throw Error('called'); };
  const { scheduler, root } = fixture('linux', runner);
  expect(scheduler.install().outcome).toBe('UNAVAILABLE');
  expect(scheduler.status().outcome).toBe('UNAVAILABLE');
  expect(existsSync(join(root, 'orch home'))).toBe(false);
});
it('installs and safely removes a macOS job while querying OS state', () => {
  let loaded = false; let definition = '';
  const calls: string[][] = [];
  const runner: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'bootstrap') { loaded = true; definition = readFileSync(args[2], 'utf8'); }
    if (args[0] === 'bootout') loaded = false;
    const label = definition.match(/<key>Label<\/key><string>(.*?)<\/string>/)?.[1];
    const block = definition.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/)?.[1] ?? '';
    const values = [...block.matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
    return { code: args[0] === 'print' && !loaded ? 1 : 0, out: loaded ? `gui/501/${label} = {\n arguments = {\n${values.join('\n')}\n }\n}` : '', err: args[0] === 'print' && !loaded ? 'not found' : '' };
  };
  const { scheduler, root } = fixture('darwin', runner);
  expect(scheduler.install(true).outcome).toBe('DRY_RUN');
  expect(calls).toHaveLength(0);
  expect(existsSync(join(root, 'orch home'))).toBe(false);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.status().jobs[0].loaded).toBe(true);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
  expect(scheduler.status().jobs[0].loaded).toBe(false);
});
it('does not delete a foreign Windows task and does not force creation', () => {
  let xml = ''; const calls: string[][] = [];
  const runner: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(calls.find(c => c.includes('/Create'))).not.toContain('/F');
  xml = '<Task>foreign</Task>';
  expect(scheduler.uninstall().outcome).toBe('CONFLICT');
  expect(calls.some(c => c.includes('/Delete'))).toBe(false);
});
it('retains ownership on runner failure and can retry a partial install', () => {
  let fail = true; let loaded = false; let xml = '';
  const runner: Runner = (_cmd, args) => {
    if (args[0] === '/Query') return { code: loaded ? 0 : 1, out: loaded ? xml : '', err: loaded ? '' : 'not found' };
    if (args[0] === '/Create') {
      xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
      if (fail) return { code: 1, out: '', err: 'denied' };
      loaded = true;
    }
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('ERROR');
  fail = false;
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.status().jobs[0].loaded).toBe(true);
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
});
it('preserves files on query errors and validates prefixes', () => {
  let queryFails = false;
  const runner: Runner = (_cmd, args) => ({ code: args[0] === 'print' ? 1 : 0, out: '', err: queryFails ? 'permission denied' : 'not found' });
  const { scheduler, root } = fixture('darwin', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  queryFails = true;
  expect(scheduler.uninstall().outcome).toBe('ERROR');
  expect(existsSync(join(root, 'orch home', 'service'))).toBe(true);
  expect(() => new Scheduler({ platform: 'darwin', home: root, userHome: root, node: '/node', cli: '/cli', uid: 1, user: 'x', prefix: '../bad', runner })).toThrow();
});
it('disabled install and dry run make no calls or writes and expose the exact plan', () => {
  const runner: Runner = () => { throw Error('called'); };
  const { root, scheduler } = fixture('darwin', runner);
  expect(scheduler.install(false, false)).toMatchObject({ outcome: 'INSTALLED', reason: expect.stringMatching(/disabled/i) });
  const result = scheduler.install(true);
  expect(result.plan.path).toContain('LaunchAgents');
  expect(result.plan.definition).toContain('<key>KeepAlive</key>');
  expect(existsSync(join(root, 'orch home'))).toBe(false);
});
it('accepts native Windows paths and includes scoped logon and safe power settings in dry run', () => {
  const runner: Runner = () => { throw Error('called'); };
  const scheduler = new Scheduler({ platform: 'win32', home: 'C:\\Users\\Jane\\orch', userHome: 'C:\\Users\\Jane', node: 'C:\\Program Files\\node.exe', cli: 'C:\\app\\cli.js', uid: 1, user: 'DOMAIN\\Jane', runner });
  const plan = scheduler.install(true).plan;
  expect(plan.path).toMatch(/^C:\\Users\\Jane\\orch\\service\\/);
  expect(plan.definition).toContain('<LogonTrigger><UserId>DOMAIN\\Jane</UserId>');
  expect(plan.definition).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  expect(plan.definition).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  expect(plan.definition).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
});
it('reports an unknown query failure with an unknown loaded state', () => {
  const { scheduler } = fixture('darwin', () => ({ code: 1, out: '', err: '' }));
  expect(scheduler.status()).toMatchObject({ outcome: 'ERROR', jobs: [{ loaded: null }] });
  expect(scheduler.install().outcome).toBe('ERROR');
});
it('runs a Windows task immediately and reports scheduler metadata', () => {
  let xml = ''; const calls: string[][] = [];
  const runner: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (cmd === 'powershell.exe') return { code: 0, out: JSON.stringify({ LastRunTime: '2026-01-01T00:00:00', LastTaskResult: 7, NextRunTime: '2026-01-02T00:00:00' }), err: '' };
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(calls.some(c => c.includes('/Run'))).toBe(true);
  expect(scheduler.status().jobs[0]).toMatchObject({ loaded: true, lastRun: '2026-01-01T00:00:00', lastExit: 7, nextRun: '2026-01-02T00:00:00' });
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
  expect(calls.some(c => c.includes('/Delete'))).toBe(true);
});
it('escapes XML values and Windows command arguments in generated definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-')); dirs.push(root);
  const runner: Runner = () => { throw Error('called'); };
  const common = { home: join(root, 'home & "x"'), userHome: root, node: join(root, 'node & "x"'), cli: join(root, 'cli & "x"'), uid: 1, user: 'a&b', runner };
  const mac = new Scheduler({ ...common, platform: 'darwin' }).install(true).plan!;
  expect(mac.definition).toContain('<key>ProgramArguments</key>');
  expect(mac.definition).toContain('&amp; &quot;x&quot;');
  expect(mac.definition).toContain('<key>ORCH_HOME</key>');
  expect(mac.definition).toContain('<key>RunAtLoad</key><true/>');
  const win = new Scheduler({ ...common, platform: 'win32' }).install(true).plan!;
  expect(win.definition).toContain('<UserId>a&amp;b</UserId>');
  expect(win.definition).toContain('&amp; \\&quot;x\\&quot;');
  expect(win.definition).toContain('<LogonType>InteractiveToken</LogonType>');
  expect(win.definition).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  expect(win.definition).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  expect(win.definition).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>');
});
it('keeps a loaded Windows job with unknown metadata when PowerShell fails', () => {
  const { scheduler } = fixture('win32', (cmd) => cmd === 'powershell.exe'
    ? { code: 1, out: '', err: 'unavailable' }
    : { code: 0, out: '<Task/>', err: '' });
  expect(scheduler.status()).toMatchObject({ outcome: 'STATUS', reason: 'unavailable', jobs: [{ loaded: true, lastRun: null, lastExit: null, nextRun: null }] });
});

it('rejects XML comments that impersonate the owned Windows action', () => {
  let xml = ''; let deleted = false;
  const runner: Runner = (_cmd, args) => {
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === '/Delete') deleted = true;
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  xml = '<Task><!--' + xml + '--><Actions><Exec><Command>foreign</Command><Arguments>foreign</Arguments></Exec></Actions></Task>';
  expect(scheduler.uninstall().outcome).toBe('CONFLICT');
  expect(deleted).toBe(false);
});
it('rejects symlinked ownership records and definition files', () => {
  const runner: Runner = (_cmd, args) => ({ code: args[0] === 'print' ? 1 : 0, out: '', err: args[0] === 'print' ? 'not found' : '' });
  const { scheduler, root } = fixture('darwin', runner);
  const definition = scheduler.install(true).plan!.path;
  writeFileSync(join(root, 'outside'), 'foreign');
  const parent = join(root, 'Library', 'LaunchAgents');
  // Create parent through an initial successful install, then replace its definition.
  expect(scheduler.install().outcome).toBe('INSTALLED');
  rmSync(definition); symlinkSync(join(root, 'outside'), definition);
  expect(scheduler.uninstall().outcome).toBe('CONFLICT');
  expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('foreign');
  expect(existsSync(parent)).toBe(true);
});
it('rejects macOS output that merely mentions the expected arguments in unrelated text', () => {
  let loaded = false; let definition = '';
  const runner: Runner = (_cmd, args) => {
    if (args[0] === 'bootstrap') { loaded = true; definition = readFileSync(args[2], 'utf8'); }
    if (args[0] === 'print') return { code: loaded ? 0 : 1, out: loaded ? `foreign job ${definition}` : '', err: loaded ? '' : 'not found' };
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('darwin', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.uninstall().outcome).toBe('CONFLICT');
});
it('accepts Task Scheduler normalized user SIDs and default settings while preserving identity', () => {
  let xml = ''; let removed = false;
  const runner: Runner = (cmd, args) => {
    if (cmd === 'whoami.exe') return { code: 0, out: '"DOMAIN\\user","S-1-5-21-123"\r\n', err: '' };
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') {
      xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8').replaceAll('<UserId>user</UserId>', '<UserId>S-1-5-21-123</UserId>').replace('<Settings>', '<Settings><Enabled>true</Enabled>');
    }
    if (args[0] === '/Delete') removed = true;
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
  expect(removed).toBe(true);
});
it('refuses a foreign SID and an extra trigger in normalized Windows XML', () => {
  let xml = ''; let deletes = 0;
  const runner: Runner = (cmd, args) => {
    if (cmd === 'whoami.exe') return { code: 0, out: '"DOMAIN\\user","S-1-5-21-123"', err: '' };
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === '/Delete') deletes++;
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  const original = xml;
  xml = original.replaceAll('<UserId>user</UserId>', '<UserId>S-1-5-21-999</UserId>');
  expect(scheduler.uninstall().outcome).toBe('CONFLICT');
  xml = original.replace('</Triggers>', '<TimeTrigger><Enabled>true</Enabled></TimeTrigger></Triggers>');
  expect(scheduler.uninstall().outcome).toBe('CONFLICT');
  expect(deletes).toBe(0);
});
it('ends an owned Windows task before deleting it and preserves ownership when end fails', () => {
  let xml = ''; let failEnd = true; const calls: string[] = [];
  const runner: Runner = (_cmd, args) => {
    calls.push(args[0]);
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === '/End' && failEnd) return { code: 1, out: '', err: 'access denied' };
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.uninstall().outcome).toBe('ERROR');
  expect(calls).not.toContain('/Delete');
  failEnd = false;
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
  expect(calls.lastIndexOf('/End')).toBeLessThan(calls.indexOf('/Delete'));
});
it('retries starting an already registered owned Windows task after a failed run', () => {
  let xml = ''; let runs = 0;
  const runner: Runner = (_cmd, args) => {
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === '/Run' && ++runs === 1) return { code: 1, out: '', err: 'failed' };
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('ERROR');
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(runs).toBe(2);
});
it('deletes an owned Windows task when its instance is already stopped', () => {
  let xml = ''; let deleted = false;
  const runner: Runner = (_cmd, args) => {
    if (args[0] === '/Query') return { code: xml ? 0 : 1, out: xml, err: xml ? '' : 'not found' };
    if (args[0] === '/Create') xml = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === '/End') return { code: 1, out: '', err: 'task is not currently running' };
    if (args[0] === '/Delete') deleted = true;
    return { code: 0, out: '', err: '' };
  };
  const { scheduler } = fixture('win32', runner);
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
  expect(deleted).toBe(true);
});
it.each(['darwin', 'win32'] as const)('generates and manages an owned periodic health job on %s', (platform) => {
  const root = mkdtempSync(join(tmpdir(), 'health-scheduler-')); dirs.push(root);
  let loaded = ''; const calls: string[][] = [];
  const runner: Runner = (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'print') return { code: loaded ? 0 : 1, out: loaded, err: loaded ? '' : 'not found' };
    if (args[0] === '/Query') return { code: loaded ? 0 : 1, out: loaded, err: loaded ? '' : 'not found' };
    if (args[0] === '/Create') loaded = readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
    if (args[0] === 'bootstrap') {
      const name = args[2].split('/').pop()!.replace('.plist', '');
      loaded = `gui/1/${name} = {\n arguments = {\n${[join(root,'node'), join(root,'cli'), 'service','run','health','--home',root].join('\n')}\n }\n}`;
    }
    return { code: 0, out: loaded || '{}', err: '' };
  };
  const scheduler = new Scheduler({ platform, home: root, userHome: root, node: join(root,'node'), cli: join(root,'cli'), uid: 1, user: 'user', runner, job: 'health' });
  const plan = scheduler.install(true).plan!;
  expect(plan.definition).toContain('health');
  if (platform === 'darwin') {
    expect(plan.definition).toContain('<key>StartInterval</key><integer>1800</integer>');
    expect(plan.definition).not.toContain('<key>KeepAlive</key>');
  } else expect(plan.definition).toContain('<Interval>PT30M</Interval>');
  expect(scheduler.install().outcome).toBe('INSTALLED');
  expect(scheduler.status().jobs[0].loaded).toBe(true);
  if (platform === 'win32') {
    const original = loaded;
    loaded = loaded.replace('</TimeTrigger>', '<RandomDelay>PT24H</RandomDelay></TimeTrigger>');
    expect(scheduler.uninstall().outcome).toBe('CONFLICT');
    loaded = original;
  }
  expect(scheduler.uninstall().outcome).toBe('UNINSTALLED');
});
it('preserves and reports a loaded foreign job when roster uninstall has no ownership record', () => {
  const calls: string[] = [];
  const { scheduler } = fixture('darwin', (_cmd, args) => { calls.push(args[0]); return { code: 0, out: 'foreign', err: '' }; });
  expect(scheduler.uninstall(false, true).outcome).toBe('CONFLICT');
  expect(calls).toEqual(['print']);
});
