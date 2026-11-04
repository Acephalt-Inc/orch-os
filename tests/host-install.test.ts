import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHost } from '../src/host/install.js';

describe('host installer', () => {
  it('installs and restores existing settings bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host install '));
    try {
      const workspace = join(root, 'work space'); const home = join(root, 'home');
      mkdirSync(workspace); mkdirSync(home); mkdirSync(join(workspace, '.claude'));
      const settings = join(workspace, '.claude', 'settings.json');
      const before = '{ "permissions": { "allow": ["Read"] } }\n';
      const { writeFileSync } = await import('node:fs'); writeFileSync(settings, before);
      const io = { out: (_: string) => {}, err: (_: string) => {} };
      const args = ['--workspace', workspace, '--host', 'claude'];
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
      expect(readFileSync(settings, 'utf8')).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('host ownership', () => {
  for (const scope of ['workspace', 'user']) it(`preserves additions in ${scope} scope`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'host '));
    try {
      const workspace = join(root, 'workspace'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
      const io = { out: (_: string) => {}, err: (_: string) => {} };
      const args = ['--workspace', workspace, '--host', 'claude', '--scope', scope];
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      const settings = join(scope === 'user' ? home : workspace, '.claude', 'settings.json');
      const { writeFileSync } = await import('node:fs');
      const value = JSON.parse(readFileSync(settings, 'utf8')); value.permissions.allow.push('UserAdded');
      value.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'custom' });
      writeFileSync(settings, JSON.stringify(value));
      expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
      const remaining = JSON.parse(readFileSync(settings, 'utf8'));
      expect(remaining.permissions.allow).toEqual(['UserAdded']);
      expect(remaining.hooks.SessionStart[0].hooks).toEqual([{ type: 'command', command: 'custom' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('dry run does not write and malformed settings are refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host '));
    try {
      const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
      const io = { out: (_: string) => {}, err: (_: string) => {} };
      const args = ['--workspace', workspace, '--host', 'claude'];
      expect(await runHost(['install', ...args, '--dry-run'], io, { home })).toBe(0);
      expect((await import('node:fs')).readdirSync(workspace)).toEqual([]);
      mkdirSync(join(workspace, '.claude')); (await import('node:fs')).writeFileSync(join(workspace, '.claude', 'settings.json'), '{"hooks": []}');
      expect(await runHost(['install', ...args], io, { home })).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('uses the Windows path adapter for locations', async () => {
  const { hostLocations } = await import('../src/host/install.js');
  const { win32 } = await import('node:path');
  expect(hostLocations('C:\\work space', 'C:\\Users\\me', 'user', win32).settings).toBe('C:\\Users\\me\\.claude\\settings.json');
});

it('distinguishes missing hooks and agreement in status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    let output = ''; const io = { out: (s: string) => { output += s; }, err: (_: string) => {} };
    const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const fs = await import('node:fs'); const file = join(workspace, '.claude', 'settings.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.hooks.Stop = []; fs.writeFileSync(file, JSON.stringify(data)); fs.unlinkSync(join(workspace, 'CLAUDE.md'));
    output = ''; expect(await runHost(['status', ...args], io, { home })).toBe(0);
    expect(output).toContain('hook stop-continue: MISSING'); expect(output).toContain('agreement: MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('restores user-scope settings and rejects another workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), other = join(root, 'other'), home = join(root, 'home');
    mkdirSync(workspace); mkdirSync(other); mkdirSync(home); mkdirSync(join(home, '.claude'));
    const file = join(home, '.claude', 'settings.json'), before = '{"custom": true}\n'; fs.writeFileSync(file, before);
    const io = { out: (_: string) => {}, err: (_: string) => {} };
    const args = ['--workspace', workspace, '--host', 'claude', '--scope', 'user'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    expect(await runHost(['uninstall', '--workspace', other, '--host', 'claude', '--scope', 'user'], io, { home })).toBe(1);
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses a linked .claude directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    fs.symlinkSync(home, join(workspace, '.claude'), 'dir');
    expect(await runHost(['install', '--workspace', workspace, '--host', 'claude'], { out: () => {}, err: () => {} }, { home })).toBe(1);
    expect(fs.readdirSync(home)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('does not reclaim an entry re-added after a partial uninstall', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const file = join(workspace, '.claude', 'settings.json'); const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.hooks.Stop[0].hooks[0].timeout = 7; fs.writeFileSync(file, JSON.stringify(data));
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(2);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')); after.permissions = { allow: ['Bash(pwd)'] }; fs.writeFileSync(file, JSON.stringify(after));
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toContain('Bash(pwd)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('reports a hook with a changed matcher as modified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    let output = ''; const io = { out: (s: string) => { output += s; }, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const file = join(workspace, '.claude', 'settings.json'); const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.hooks.PreToolUse[0].matcher = 'Read'; fs.writeFileSync(file, JSON.stringify(data));
    output = ''; expect(await runHost(['status', ...args], io, { home })).toBe(0);
    expect(output).toContain('hook pre-tool-guard: MODIFIED-BY-USER');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('removes only empty containers created by install after settings edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home); mkdirSync(join(workspace, '.claude'));
    const file = join(workspace, '.claude', 'settings.json'); fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [] }, permissions: {} }));
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.custom = true; fs.writeFileSync(file, JSON.stringify(data));
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hooks: { Stop: [] }, permissions: {}, custom: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('removes its exact agreement when the surrounding separator was edited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    const file = join(workspace, 'CLAUDE.md'); fs.writeFileSync(file, 'before\n');
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('before\n\n', 'before\n') + 'after\n');
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('before\n\nafter\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const preset of ['coding', 'research', 'ops']) for (const scope of ['workspace', 'user']) it(`runs ${preset} ${scope} lifecycle through an in-memory Windows filesystem`, async () => {
  const fs = await import('node:fs'); const { win32 } = await import('node:path');
  const key = (p: string) => win32.resolve(p).toLowerCase();
  const entries = new Map<string, string | null>([[key('C:\\'), null], [key('C:\\work space'), null], [key('C:\\home'), null]]);
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const adapter = {
    lstatSync(p: string) {
      const k = key(p); if (!entries.has(k)) throw missing(); const dir = entries.get(k) === null;
      return { isSymbolicLink: () => false, isDirectory: () => dir, isFile: () => !dir };
    },
    readFileSync(p: string) { const v = entries.get(key(p)); if (typeof v !== 'string') throw missing(); return v; },
    writeFileSync(p: string, data: string, options?: { flag?: string }) {
      const k = key(p); if (options?.flag === 'wx' && entries.has(k)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      if (!entries.has(key(win32.dirname(p)))) throw missing(); entries.set(k, data);
    },
    mkdirSync(p: string, options?: { recursive?: boolean }) {
      const k = key(p); if (entries.has(k)) { if (options?.recursive) return; throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }
      const parent = win32.dirname(p); if (!entries.has(key(parent))) { if (!options?.recursive) throw missing(); this.mkdirSync(parent, options); }
      entries.set(k, null);
    },
    unlinkSync(p: string) { if (!entries.delete(key(p))) throw missing(); },
    rmdirSync(p: string) { const k = key(p); if ([...entries.keys()].some(other => other !== k && other.startsWith(k + '\\'))) throw Error('not empty'); if (!entries.delete(k)) throw missing(); },
  } as unknown as typeof fs;
  const io = { out: (_: string) => {}, err: (_: string) => {} };
  const args = ['--workspace', 'C:\\work space', '--host', 'claude', '--scope', scope, '--preset', preset];
  const deps = { home: 'C:\\home', path: win32, platform: 'win32' as const, fs: adapter };
  expect(await runHost(['install', ...args], io, deps)).toBe(0);
  const settingsPath = key(`C:\\${scope === 'user' ? 'home' : 'work space'}\\.claude\\settings.json`);
  expect(JSON.parse(entries.get(settingsPath) as string).permissions.allow).toEqual(expectedPresets[preset]);
  expect(await runHost(['status', ...args], io, deps)).toBe(0);
  expect(await runHost(['uninstall', ...args], io, deps)).toBe(0);
  expect(entries.has(key(`C:\\${scope === 'user' ? 'home' : 'work space'}\\.claude\\settings.json`))).toBe(false);
});

it('restores original agreement before a user append', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    const file = join(workspace, 'CLAUDE.md'); fs.writeFileSync(file, 'before\n');
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    fs.appendFileSync(file, 'after\n'); expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('before\nafter\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('protects ownership backups from git and preserves an edited ignore file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const ignore = join(workspace, '.orch-host-workspace', '.gitignore'); expect(fs.readFileSync(ignore, 'utf8')).toBe('*\n');
    fs.writeFileSync(ignore, 'user edit\n'); expect(await runHost(['uninstall', ...args], io, { home })).toBe(2);
    expect(fs.readFileSync(ignore, 'utf8')).toBe('user edit\n'); expect(fs.existsSync(join(workspace, '.orch-host-workspace', 'manifest.json'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('cleans retained state once a modified hook is removed without reclaiming a re-added agreement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const settings = join(workspace, '.claude', 'settings.json'), agreement = join(workspace, 'CLAUDE.md');
    const block = fs.readFileSync(agreement, 'utf8'); const data = JSON.parse(fs.readFileSync(settings, 'utf8')); data.hooks.Stop[0].hooks[0].timeout = 7; fs.writeFileSync(settings, JSON.stringify(data));
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(2);
    const remaining = JSON.parse(fs.readFileSync(settings, 'utf8')); remaining.hooks.Stop = []; fs.writeFileSync(settings, JSON.stringify(remaining)); fs.writeFileSync(agreement, block);
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(fs.readFileSync(agreement, 'utf8')).toBe(block);
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(join(workspace, '.orch-host-workspace'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('reports interrupted install as incomplete and uninstalls it safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home); mkdirSync(join(workspace, '.claude'));
    const settings = join(workspace, '.claude', 'settings.json'), original = '{"permissions":{"allow":["Read"]}}\n'; fs.writeFileSync(settings, original);
    let output = ''; const io = { out: (s: string) => { output += s; }, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude'];
    const failing = { ...fs, writeFileSync: (p: fs.PathOrFileDescriptor, data: string, options?: any) => {
      if (p === join(workspace, 'CLAUDE.md')) throw Object.assign(new Error('injected'), { code: 'EIO' });
      return fs.writeFileSync(p, data, options);
    } } as typeof fs;
    expect(await runHost(['install', ...args], io, { home, fs: failing })).toBe(1);
    output = ''; expect(await runHost(['install', ...args], io, { home })).toBe(2);
    expect(output).toContain('permission Read: INSTALLED'); expect(output).toContain('agreement: MISSING'); expect(output).toContain('uninstall');
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(fs.readFileSync(settings, 'utf8')).toBe(original); expect(fs.existsSync(join(workspace, '.orch-host-workspace'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const expectedCommon = ['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch)', 'Bash(git branch --list)', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(orch mailbox read:*)', 'Bash(orch host status:*)', 'Bash(orch lead status:*)'];
const expectedPresets: Record<string, string[]> = {
  coding: [...expectedCommon, 'Bash(npm test:*)', ...['test', 'lint', 'typecheck', 'build'].map(x => `Bash(npm run ${x}:*)`), ...['pnpm', 'yarn'].flatMap(p => ['test', 'lint', 'typecheck', 'build'].flatMap(x => [`Bash(${p} ${x}:*)`, `Bash(${p} run ${x}:*)`])), 'Bash(node --version)'],
  research: [...expectedCommon, 'WebSearch', 'WebFetch'],
  ops: [...expectedCommon, 'Bash(orch task status:*)', 'Bash(orch task list:*)', 'Bash(orch mem search:*)'],
};

for (const [preset, required] of Object.entries(expectedPresets)) for (const scope of ['workspace', 'user']) {
  it(`installs and restores ${preset} permissions in ${scope} scope`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'host preset '));
    try {
      const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
      const base = scope === 'user' ? home : workspace; mkdirSync(join(base, '.claude'));
      const file = join(base, '.claude', 'settings.json'); const before = '{ "permissions": { "allow": ["Read", "Bash(git status)"] } }\n'; fs.writeFileSync(file, before);
      let output = ''; const io = { out: (s: string) => { output += s; }, err: (_: string) => {} };
      const args = ['--workspace', workspace, '--host', 'claude', '--scope', scope, '--preset', preset];
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(installed.permissions.allow).toEqual(['Read', 'Bash(git status)', ...required.filter(x => x !== 'Read')]);
      const record = JSON.parse(fs.readFileSync(join(base, `.orch-host-${scope}`, 'manifest.json'), 'utf8'));
      expect(record.before).toBe(before); expect(record.required).toEqual(required); expect(record.allow).toEqual(required.filter(x => x !== 'Read'));
      expect(await runHost(['uninstall', ...args], io, { home })).toBe(0); expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      installed.permissions.allow = installed.permissions.allow.filter((x: string) => x !== 'Bash(git status:*)'); fs.writeFileSync(file, JSON.stringify(installed));
      output = ''; expect(await runHost(['status', ...args], io, { home })).toBe(0); expect(output).toContain('permission Bash(git status:*): MISSING');
      expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toEqual(['Read', 'Bash(git status)']);
      expect(await runHost(['install', ...args], io, { home })).toBe(0);
      expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ permissions: { allow: ['Read', 'Bash(git status)'] } }, null, 2) + '\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const scope of ['workspace', 'user']) it(`retains a user-owned prefix and newly added exact rule in ${scope}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'host ownership '));
  try {
    const fs = await import('node:fs'); const workspace = join(root, 'work'), home = join(root, 'home'); mkdirSync(workspace); mkdirSync(home);
    const base = scope === 'user' ? home : workspace; mkdirSync(join(base, '.claude')); const file = join(base, '.claude', 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(git status:*)'] } }));
    const io = { out: (_: string) => {}, err: (_: string) => {} }; const args = ['--workspace', workspace, '--host', 'claude', '--scope', scope];
    expect(await runHost(['install', ...args], io, { home })).toBe(0);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.permissions.allow.push('Bash(git status)'); fs.writeFileSync(file, JSON.stringify(data));
    expect(await runHost(['uninstall', ...args], io, { home })).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toEqual(['Bash(git status:*)', 'Bash(git status)']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
