// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withLock } from '../lock.js';
import type { Messages } from '../messages.js';
import { identity, ownership, sameIdentity } from '../worker-ownership.js';
import { WakeWatch } from './wake.js';
import type { Runner } from './scheduler.js';
export type DiskOptions = { home: string; root: string; messages: Messages; reader: string; platform: NodeJS.Platform; runner: Runner; floorBytes: number; staleDays: number; mode: 'dry-run' | 'apply'; now?: () => number; diskFree?: () => number };
type Row = { path: string; worktree?: string; action: 'KEEP' | 'DELETE' | 'WOULD_DELETE'; reason: string };
const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export class Disk {
  constructor(readonly options: DiskOptions) {}
  private git(path: string, args: string[]) { return this.options.runner('git', ['--no-optional-locks', '-C', path, ...args]); }
  private ownedRoot(): string {
    const root = realpathSync(this.options.root);
    if (root !== resolve(this.options.root) || !inside(realpathSync(this.options.home), root)) throw new Error('worker root outside ORCH home or linked');
    return root;
  }
  private ownedWorktree(path: string): string {
    const worktree = realpathSync(path), area = join(realpathSync(this.options.home), 'worktrees');
    if (!inside(area, worktree)) throw new Error(`worktree outside ORCH-home worktree area: ${worktree}`);
    return worktree;
  }
  private free(): number {
    const o = this.options;
    if (o.diskFree) return o.diskFree();
    if (o.platform !== 'win32') { const s = statfsSync(o.home); return s.bavail * s.bsize; }
    const script = `[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot('${o.home.replace(/'/g, "''")}')).AvailableFreeSpace`;
    const r = o.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    if (r.code !== 0 || !/^\d+\s*$/.test(r.out)) throw new Error('Windows free-space probe unavailable');
    return Number(r.out.trim());
  }
  private absent(pid: number): boolean {
    const o = this.options;
    if (o.platform === 'win32') throw new Error('UNAVAILABLE: Windows orphan-process absence needs durable process-tree ownership');
    const r = o.runner('ps', ['-A', '-o', 'pid=,pgid=,stat=']);
    if (r.code !== 0) throw new Error('process probe unavailable');
    const rows = r.out.split('\n').filter(l => l.trim()).map(l => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+\S+$/);
      if (!m) throw new Error('invalid process probe');
      return [Number(m[1]), Number(m[2])];
    });
    return !rows.some(([p, group]) => p === pid || group === pid);
  }
  private newest(path: string): number {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) throw new Error('linked worker data');
    return Math.max(s.mtimeMs / 1000, ...(s.isDirectory() ? readdirSync(path).map(n => this.newest(join(path, n))) : []));
  }
  private inspect(name: string, now: number): string {
    const o = this.options, dir = join(o.root, name);
    if (!inside(this.ownedRoot(), realpathSync(dir))) throw new Error('worker directory outside worker root');
    const record = ownership(o.root)[name];
    if (!record || record.directory.path !== resolve(dir) || !sameIdentity(record.directory)) throw new Error('unowned or replaced directory');
    const p = join(dir, 'worker.json');
    if (lstatSync(p).isSymbolicLink()) throw new Error('linked worker metadata');
    const m = JSON.parse(readFileSync(p, 'utf8')), wt = m.worktree;
    if (m.name !== name || !Number.isSafeInteger(m.pid) || m.pid < 2 || !Number.isFinite(m.started_at)) throw new Error('invalid worker metadata');
    if (!wt?.created || !record.worktree || wt.path !== record.worktree.path || wt.repo !== record.worktree.repo || !sameIdentity(record.worktree)) throw new Error('worktree not owned or replaced');
    this.ownedWorktree(wt.path);
    identity(wt.repo);
    if (realpathSync(wt.repo) === realpathSync(wt.path) || m.workdir !== wt.path) throw new Error('worktree identity mismatch');
    if (now - Math.max(m.started_at, this.newest(dir)) <= o.staleDays * 86400) throw new Error('not stale');
    if (!this.absent(m.pid)) throw new Error('worker or descendant still running');
    // A second worker may have attached to this worktree, including one with no valid PID record.
    for (const e of readdirSync(o.root, { withFileTypes: true })) if (e.name !== name && (e.isDirectory() || e.isSymbolicLink())) {
      const other = join(o.root, e.name, 'worker.json');
      if (existsSync(other)) {
        if (lstatSync(other).isSymbolicLink()) throw new Error('linked peer metadata');
        const peer = JSON.parse(readFileSync(other, 'utf8'));
        if (typeof peer.workdir === 'string' && resolve(peer.workdir) === resolve(wt.path)) throw new Error('shared worktree');
      }
    }
    // Compare Git's Windows path spelling through the filesystem's canonical name.
    const target = realpathSync.native(wt.path);
    const sameDirectory = (p: string) => { try { return realpathSync.native(p) === target; } catch { return false; } };
    const list = this.git(wt.repo, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
    if (list.code !== 0 || !list.out.split('\n').some(l => l.startsWith('worktree ') && sameDirectory(l.slice('worktree '.length)))) throw new Error('worktree registration mismatch');
    const top = this.git(wt.path, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || !sameDirectory(top.out.trim())) throw new Error('worktree root mismatch');
    const flags = this.git(wt.path, ['ls-files', '-v', '-z']);
    if (flags.code !== 0 || flags.out.split('\0').some(line => /^[a-zS] /.test(line))) throw new Error('hidden index entries or index probe unavailable');
    const status = this.git(wt.path, ['status', '--porcelain', '--untracked-files=all', '--ignored']);
    if (status.code !== 0 || status.out.trim()) throw new Error('dirty, ignored files, or status unavailable');
    return wt.path;
  }
  tick(preview = false): Record<string, any> {
    const o = this.options, now = o.now?.() ?? Date.now() / 1000;
    if (!['darwin', 'win32'].includes(o.platform)) return { outcome: 'UNAVAILABLE', reason: 'Disk service is unavailable on this platform', directories: [] };
    let free: number;
    try { free = this.free(); if (!Number.isFinite(free) || free < 0) throw new Error('invalid free-space result'); }
    catch (e) { return { outcome: 'UNAVAILABLE', reason: String(e), directories: [] }; }
    const finding = { ts: new Date(now * 1000).toISOString(), disk_free_bytes: free, floor_bytes: o.floorBytes, low_disk: free < o.floorBytes };
    if (existsSync(o.root)) {
      try { this.ownedRoot(); }
      catch (e) {
        const reason = String(e);
        const directories: Row[] = readdirSync(o.root, { withFileTypes: true })
          .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
          .map(entry => ({ path: join(o.root, entry.name), action: 'KEEP', reason }));
        if (!preview) new WakeWatch(o.home, o.messages, o.reader, () => []).tick(undefined, finding);
        return { outcome: 'UNAVAILABLE', reason, ...finding, directories };
      }
    }
    const apply = !preview && o.mode === 'apply';
    const report = () => {
      const directories: Row[] = [];
      if (existsSync(o.root)) {
        identity(o.root);
        for (const e of readdirSync(o.root, { withFileTypes: true })) if (e.isDirectory() || e.isSymbolicLink()) {
          const row: Row = { path: join(o.root, e.name), action: 'KEEP', reason: '' }; directories.push(row);
          try {
            const wt = this.inspect(e.name, now);
            if (apply) {
              // Starts share this lock. Re-read identities, metadata, process and git evidence before removal.
              this.inspect(e.name, now);
              const m = JSON.parse(readFileSync(join(row.path, 'worker.json'), 'utf8'));
              const r = this.git(m.worktree.repo, ['worktree', 'remove', '--', wt]);
              if (r.code !== 0) throw new Error('worktree removal refused');
              rmSync(row.path, { recursive: true });
            }
            row.worktree = wt; row.action = apply ? 'DELETE' : 'WOULD_DELETE'; row.reason = 'eligible';
          } catch (e) { row.reason = String(e); }
        }
      }
      return directories;
    };
    const directories = apply && existsSync(o.root) ? withLock(o.root + '.maintenance.lock', report, { staleMs: Infinity }) : report();
    if (!preview) new WakeWatch(o.home, o.messages, o.reader, () => []).tick(undefined, finding);
    return { outcome: apply && o.platform === 'win32' ? 'UNAVAILABLE' : apply ? 'APPLIED' : 'DRY_RUN',
      ...(o.platform === 'win32' ? { cleanup: { outcome: 'UNAVAILABLE', reason: 'Windows orphan-process absence needs durable process-tree ownership' } } : {}), ...finding, directories };
  }
}
