// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '../lock.js';

export type ProcessEvidence = { start: string; identity: string };
export type AwakeRunner = { start(command: string, args: string[]): { pid: number } & ProcessEvidence; inspect(pid: number): ProcessEvidence | null; stop(pid: number): boolean };
type RecordFile = ProcessEvidence & { version: 1; owner: 'orch-awake-v1'; home: string; platform: NodeJS.Platform; pid: number; deadline: string; seconds: number };
type Result = { outcome: 'ON' | 'OFF' | 'STATUS' | 'DRY_RUN' | 'UNAVAILABLE' | 'ERROR' | 'CONFLICT'; reason?: string; active?: boolean; deadline?: string };
type Options = { home: string; platform: NodeJS.Platform; runner: AwakeRunner; now?: () => Date };
const link = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };
export function awakeSpec(platform: NodeJS.Platform, seconds: number): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-t', String(seconds)] };
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class AwakeNative { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; if ([AwakeNative]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }; Start-Sleep -Seconds ${seconds}; [void][AwakeNative]::SetThreadExecutionState([uint32]2147483648)`;
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}
function matchesSpec(platform: NodeJS.Platform, args: string[], identity: string): boolean {
  if (platform === 'darwin') return /^(?:\/[^\s]+\/)?caffeinate\s+-i\s+-t\s+\d+\s*$/.test(identity) && identity.trim().endsWith(args.join(' '));
  if (platform === 'win32') {
    const match = identity.match(/^"?(?:[^"\r\n]*[\\/])?powershell(?:\.exe)?"?\s+-NoProfile\s+-NonInteractive\s+-EncodedCommand\s+(\S+)\s*$/i);
    return !!match && match[1] === args[args.length - 1];
  }
  return false;
}
function helperIdentity(platform: NodeJS.Platform, seconds: number, identity: string): boolean {
  return matchesSpec(platform, awakeSpec(platform, seconds).args, identity);
}
export function systemAwakeRunner(platform: NodeJS.Platform): AwakeRunner {
  const inspect = (pid: number): ProcessEvidence | null => {
    if (platform === 'darwin') {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
      if (r.error) throw r.error;
      if (r.status === 1 && !r.stdout.trim()) return null;
      if (r.status !== 0) throw new Error(r.stderr || 'Process inspection failed');
      const m = r.stdout.trim().match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/);
      if (!m) throw new Error('Process evidence unavailable');
      return { start: m[1], identity: m[2] };
    }
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if ($null -eq $p) { exit 3 }; @{start=$p.CreationDate.ToUniversalTime().ToString('o');identity=$p.CommandLine} | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status === 3) return null;
    if (r.status !== 0) throw new Error(r.stderr || 'Process inspection failed');
    const e = JSON.parse(r.stdout) as ProcessEvidence;
    if (!e.start || !e.identity) throw new Error('Process evidence unavailable');
    return e;
  };
  return {
    start(command, args) {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => { /* surfaced by missing PID or inspection */ });
      child.unref();
      if (!child.pid) throw new Error('Unable to start awake process');
      let evidence: ProcessEvidence | null = null;
      try {
        evidence = inspect(child.pid);
        if (!evidence || !matchesSpec(platform, args, evidence.identity)) throw new Error('Awake process identity could not be verified');
        return { pid: child.pid, ...evidence };
      } catch (e) {
        let action = 'preserved because ownership or exit could not be verified';
        try {
          const current = inspect(child.pid);
          if (!current) action = 'already exited';
          else if (evidence && current.start === evidence.start && current.identity === evidence.identity && matchesSpec(platform, args, current.identity)) {
            process.kill(child.pid);
            action = 'sent a stop signal after identity verification; exit is unverified';
          }
        } catch { /* preserve uncertain process */ }
        throw new Error(`Awake startup failed for PID ${child.pid} (${action}): ${String(e)}`);
      }
    },
    inspect,
    stop(pid) { try { process.kill(pid); return true; } catch { return false; } },
  };
}
export class Awake {
  private dir: string; private path: string;
  constructor(private options: Options) { this.dir = join(options.home, 'service'); this.path = join(this.dir, 'awake.json'); }
  private unsupported(): Result | null { return ['darwin', 'win32'].includes(this.options.platform) ? null : { outcome: 'UNAVAILABLE', reason: 'Awake is unavailable on this platform' }; }
  private unsafe() { return link(this.options.home) || link(this.dir) || link(this.path) || link(this.path + '.lock'); }
  private read(): RecordFile | null {
    if (!existsSync(this.path)) return null;
    let r: RecordFile; try { r = JSON.parse(readFileSync(this.path, 'utf8')); } catch { throw new Error('Unowned awake record'); }
    if (r.version !== 1 || r.owner !== 'orch-awake-v1' || r.home !== this.options.home || r.platform !== this.options.platform || !Number.isSafeInteger(r.seconds) || r.seconds < 1 || r.seconds > 31536000 || typeof r.identity !== 'string' || !helperIdentity(r.platform, r.seconds, r.identity) || !Number.isSafeInteger(r.pid) || r.pid < 1 || typeof r.start !== 'string' || !r.start || typeof r.identity !== 'string' || !r.identity || !Number.isFinite(Date.parse(r.deadline))) throw new Error('Unowned awake record');
    return r;
  }
  private run(fn: () => Result): Result {
    try {
      if (this.unsafe()) return { outcome: 'CONFLICT', reason: 'Awake path is a symbolic link' };
      mkdirSync(this.dir, { recursive: true });
      return withLock(this.path + '.lock', () => this.unsafe() ? { outcome: 'CONFLICT', reason: 'Awake path is a symbolic link' } : fn());
    } catch (e) { return { outcome: 'ERROR', reason: String(e) }; }
  }
  private evidence(r: RecordFile): 'absent' | 'match' | 'mismatch' {
    const e = this.options.runner.inspect(r.pid);
    return !e ? 'absent' : e.start === r.start && e.identity === r.identity ? 'match' : 'mismatch';
  }
  on(input: { hours?: number; until?: string; dryRun?: boolean } = {}): Result {
    const unsupported = this.unsupported(); if (unsupported) return unsupported;
    const now = (this.options.now ?? (() => new Date()))(); let seconds: number;
    if (input.hours !== undefined && input.until !== undefined) return { outcome: 'ERROR', reason: 'Choose hours or until' };
    if (input.until !== undefined) {
      const m = /^(\d{2}):(\d{2})$/.exec(input.until);
      if (!m || +m[1] > 23 || +m[2] > 59) return { outcome: 'ERROR', reason: 'Invalid time' };
      const end = new Date(now); end.setHours(+m[1], +m[2], 0, 0); if (end <= now) end.setDate(end.getDate() + 1);
      seconds = Math.ceil((end.getTime() - now.getTime()) / 1000);
    } else {
      const hours = input.hours ?? 8;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) return { outcome: 'ERROR', reason: 'Invalid hours' };
      seconds = Math.ceil(hours * 3600);
    }
    const deadline = new Date(now.getTime() + seconds * 1000).toISOString();
    if (input.dryRun) return { outcome: 'DRY_RUN', deadline };
    return this.run(() => {
      let existing: RecordFile | null; try { existing = this.read(); } catch { return { outcome: 'CONFLICT', reason: 'Unowned awake record' }; }
      if (existing) return { outcome: 'CONFLICT', reason: 'Awake record already exists; turn it off first' };
      const spec = awakeSpec(this.options.platform, seconds);
      const started = this.options.runner.start(spec.command, spec.args);
      if (!helperIdentity(this.options.platform, seconds, started.identity)) throw new Error(`Awake process identity could not be verified (PID ${started.pid})`);
      const record: RecordFile = { version: 1, owner: 'orch-awake-v1', home: this.options.home, platform: this.options.platform, ...started, deadline, seconds };
      try { writeFileSync(this.path, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
      catch (e) {
        try { if (this.evidence(record) === 'match') this.options.runner.stop(record.pid); } catch { /* preserve uncertain process */ }
        throw new Error(`Unable to save awake ownership for PID ${record.pid}: ${String(e)}`);
      }
      return { outcome: 'ON', active: true, deadline };
    });
  }
  status(): Result {
    const unsupported = this.unsupported(); if (unsupported) return unsupported;
    return this.run(() => {
      let r: RecordFile | null; try { r = this.read(); } catch { return { outcome: 'CONFLICT', reason: 'Unowned awake record' }; }
      if (!r) return { outcome: 'STATUS', active: false };
      const state = this.evidence(r);
      if (state === 'mismatch') return { outcome: 'CONFLICT', reason: 'Process identity changed' };
      return { outcome: 'STATUS', active: state === 'match', deadline: r.deadline };
    });
  }
  off(dryRun = false): Result {
    const unsupported = this.unsupported(); if (unsupported) return unsupported;
    if (dryRun) return { outcome: 'DRY_RUN' };
    return this.run(() => {
      let r: RecordFile | null; try { r = this.read(); } catch { return { outcome: 'CONFLICT', reason: 'Unowned awake record' }; }
      if (!r) return { outcome: 'OFF', active: false };
      const state = this.evidence(r);
      if (state === 'mismatch') return { outcome: 'CONFLICT', reason: 'Process identity changed' };
      if (state === 'match') {
        if (!this.options.runner.stop(r.pid)) return { outcome: 'ERROR', reason: 'Unable to stop awake process' };
        if (this.evidence(r) !== 'absent') return { outcome: 'ERROR', reason: 'Awake process exit could not be verified' };
      }
      unlinkSync(this.path); return { outcome: 'OFF', active: false };
    });
  }
}
