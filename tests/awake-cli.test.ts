import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { useTmpHome } from './_helpers.js';
import type { AwakeRunner } from '../src/service/awake.js';
const ctx = useTmpHome();
it.each(['darwin', 'win32'] as const)('awake CLI round trips through an injected runner on %s', async platform => {
  let live = false; let identity = '';
  const awake: AwakeRunner = { start: (cmd, args) => { live = true; identity = [cmd, ...args].join(' '); return { pid: 123, start: 'created', identity }; }, inspect: () => live ? { start: 'created', identity } : null, stop: () => { live = false; return true; } };
  const run = async (args: string[]) => {
    let out = ''; const code = await main(['awake', ...args], { out: s => { out += s; }, err: () => {}, stdin: () => '' }, { platform, awake });
    return { code, ...JSON.parse(out) };
  };
  expect(await run(['on', '--hours', '2'])).toMatchObject({ code: 0, outcome: 'ON' });
  expect(await run(['status'])).toMatchObject({ code: 0, active: true });
  expect(await run(['off'])).toMatchObject({ code: 0, outcome: 'OFF' });
  expect(await run(['status'])).toMatchObject({ code: 0, active: false });
});
it('awake Linux is typed UNAVAILABLE and dry run writes nothing', async () => {
  let out = ''; const io = { out: (s: string) => { out += s; }, err: () => {}, stdin: () => '' };
  expect(await main(['awake', 'on'], io, { platform: 'linux' })).toBe(1);
  expect(JSON.parse(out).outcome).toBe('UNAVAILABLE'); out = '';
  expect(await main(['awake', 'on', '--hours', '1', '--dry-run'], io, { platform: 'darwin' })).toBe(0);
  expect(readdirSync(ctx.home)).toEqual([]);
});
