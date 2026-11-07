import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as locks from '../src/lock.js';
import { Workers } from '../src/workers.js';
import { useTmpHome } from './_helpers.js';
const ctx = useTmpHome();
afterEach(() => vi.restoreAllMocks());
it('rechecks an intervening same-name start under a nonexpiring maintenance lock', () => {
  const root = join(ctx.home, 'workers');
  vi.spyOn(locks, 'withLock').mockImplementation((path, fn, opts) => {
    expect(path).toBe(root + '.maintenance.lock'); expect(opts?.staleMs).toBe(Infinity);
    mkdirSync(join(root, 'w'), { recursive: true }); writeFileSync(join(root, 'w', 'PID'), String(process.pid));
    return fn();
  });
  const w = new Workers({}, root, join(ctx.home, 'load.json'));
  expect(() => w.start('w', { command: [process.execPath, '-e', 'process.exit(0)'], workdir: ctx.home, force: true })).toThrow('already running');
});
