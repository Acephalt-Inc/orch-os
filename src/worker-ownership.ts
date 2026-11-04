// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { snapshot } from './service/wake.js';
import type { Worktree } from './workers.js';

export type Identity = { path: string; dev: number; ino: number; birth: number };
export type OwnedWorker = { directory: Identity; worktree?: Identity & { repo: string } };
export function identity(path: string): Identity {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('linked or noncanonical directory');
  return { path: resolve(path), dev: s.dev, ino: s.ino, birth: s.birthtimeMs };
}
export function sameIdentity(record: Identity): boolean {
  return JSON.stringify(identity(record.path)) === JSON.stringify({ path: record.path, dev: record.dev, ino: record.ino, birth: record.birth });
}
export function ownership(root: string): Record<string, OwnedWorker> {
  identity(root);
  const p = join(root, '.ownership.json');
  if (!existsSync(p)) return {};
  if (lstatSync(p).isSymbolicLink()) throw new Error('linked ownership record');
  const v = JSON.parse(readFileSync(p, 'utf8'));
  if (v.owner !== 'orch-workers-v1' || v.root !== realpathSync(root) || !v.workers || typeof v.workers !== 'object' || Array.isArray(v.workers)) throw new Error('invalid worker ownership record');
  return v.workers;
}
/** Called only under the worker maintenance lock, after ORCH creates a directory. */
export function recordWorkerOwnership(root: string, name: string, created: boolean, wt?: Worktree | null): void {
  const records = ownership(root), directory = identity(join(root, name));
  const prior = records[name];
  if (!created && (!prior || !sameIdentity(prior.directory))) return;
  const worktree = wt?.created ? { ...identity(wt.path), repo: realpathSync(wt.repo) } : undefined;
  records[name] = { directory, ...(worktree ? { worktree } : {}) };
  snapshot(join(root, '.ownership.json'), JSON.stringify({ owner: 'orch-workers-v1', root: realpathSync(root), workers: records }));
}
