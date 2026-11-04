// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { withLock } from '../lock.js';

export type Runner = (command: string, args: string[]) => { code: number; out: string; err: string };
type Options = { platform: NodeJS.Platform; home: string; userHome: string; node: string; cli: string; uid: number; user: string; prefix?: string; job?: "wake-watch" | "health"; runner: Runner };
type Outcome = 'UNAVAILABLE' | 'DRY_RUN' | 'INSTALLED' | 'UNINSTALLED' | 'STATUS' | 'ERROR' | 'CONFLICT';
type Job = { job: string; loaded: boolean | null; lastRun: string | null; lastExit: number | null; nextRun: string | null; raw?: string };
type Result = { outcome: Outcome; jobs: Job[]; reason?: string; plan?: { path: string; definition: string } };
type Manifest = { platform: NodeJS.Platform; job: string; path: string; definition: string };
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// Windows command-line argument encoding used by the Microsoft C runtime.
const unsafeLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };
const decode = (s: string) => s.replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos);/gi, (_, n: string, name: string) => n ? String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()]);
const quote = (s: string) => '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';

export class Scheduler {
  private readonly name: string;
  private readonly path: string;
  private readonly manifest: string;
  private readonly args: string[];
  private readonly serviceDir: string;
  private readonly definitionDir: string;
  constructor(private readonly options: Options) {
    const prefix = options.prefix ?? 'org.orch';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(prefix)) throw new Error('Invalid scheduler prefix');
    const paths = options.platform === 'win32' && win32.isAbsolute(options.home) && !posix.isAbsolute(options.home) ? win32 : posix;
    if (![options.home, options.userHome, options.node, options.cli].every(paths.isAbsolute)) throw new Error('Scheduler paths must be absolute');
    this.serviceDir = paths.join(options.home, 'service');
    this.name = `${prefix}.${createHash('sha256').update(options.home).digest('hex').slice(0, 16)}.${options.job ?? 'wake-watch'}`;
    this.path = options.platform === 'darwin' ? paths.join(options.userHome, 'Library', 'LaunchAgents', `${this.name}.plist`) : paths.join(this.serviceDir, `${this.name}.xml`);
    this.manifest = paths.join(this.serviceDir, `${this.name}.json`);
    this.definitionDir = paths.dirname(this.path);
    this.args = [options.node, options.cli, 'service', 'run', options.job ?? 'wake-watch', '--home', options.home];
  }
  private result(outcome: Outcome, reason?: string, jobs: Job[] = []): Result { return { outcome, jobs, ...(reason ? { reason } : {}) }; }
  private unsupported(): Result | null { return this.options.platform === 'darwin' || this.options.platform === 'win32' ? null : this.result('UNAVAILABLE', 'Scheduler is unavailable on this platform'); }
  private definition(): string {
    const health = this.options.job === 'health';
    const trigger = health ? '<TimeTrigger><Repetition><Interval>PT30M</Interval></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>' : `<LogonTrigger><UserId>${xml(this.options.user)}</UserId><Enabled>true</Enabled></LogonTrigger>`;
    const a = this.args.map(v => `<string>${xml(v)}</string>`).join('');
    if (this.options.platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(this.name)}</string><key>ProgramArguments</key><array>${a}</array><key>RunAtLoad</key><true/>${health ? '<key>StartInterval</key><integer>1800</integer>' : '<key>KeepAlive</key><true/>'}<key>EnvironmentVariables</key><dict><key>ORCH_HOME</key><string>${xml(this.options.home)}</string></dict></dict></plist>\n`;
    const argumentsValue = this.args.slice(1).map(quote).join(' ');
    return `<?xml version="1.0" encoding="UTF-8"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${xml(this.name)}</Description></RegistrationInfo><Triggers>${trigger}</Triggers><Principals><Principal id="Author"><UserId>${xml(this.options.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(this.args[0])}</Command><Arguments>${xml(argumentsValue)}</Arguments></Exec></Actions></Task>`;
  }
  private query() {
    return this.options.platform === 'darwin'
      ? this.options.runner('launchctl', ['print', `gui/${this.options.uid}/${this.name}`])
      : this.options.runner('schtasks', ['/Query', '/TN', this.name, '/XML']);
  }
  private owned(m: Manifest): boolean {
    return m.platform === this.options.platform && m.job === this.name && m.path === this.path && m.definition === this.definition();
  }
  private read(): Manifest | null {
    if (!existsSync(this.manifest)) return null;
    const m: Manifest = JSON.parse(readFileSync(this.manifest, 'utf8'));
    if (!this.owned(m)) throw new Error('Ownership record does not match this job');
    return m;
  }
  private absent(q: { code: number; out: string; err: string }): boolean {
    return q.code !== 0 && /could not find|not found|cannot find|does not exist/i.test(q.err + ' ' + q.out);
  }
  private matches(output: string): boolean {
    if (this.options.platform === 'win32') {
      const actual = output.replace(/<!--[\s\S]*?-->/g, '');
      const expected = this.definition();
      const blocks = (source: string, tag: string) => [...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'gi'))].map(m => m[1]);
      const one = (source: string, tag: string) => { const found = blocks(source, tag); return found.length === 1 ? found[0] : null; };
      const value = (source: string, tag: string) => { const v = one(source, tag); return v === null ? null : decode(v.trim()); };
      const registration = one(actual, 'RegistrationInfo'), actions = one(actual, 'Actions'), principals = one(actual, 'Principals'), triggers = one(actual, 'Triggers'), settings = one(actual, 'Settings');
      if (!registration || !actions || !principals || !triggers || !settings) return false;
      const exec = one(actions, 'Exec'), principal = one(principals, 'Principal'), trigger = one(triggers, this.options.job === 'health' ? 'TimeTrigger' : 'LogonTrigger');
      if (!exec || !principal || !trigger || (actions.match(/<(?:Exec|ComHandler|SendEmail|ShowMessage)(?:\s|>)/gi) || []).length !== 1 || (triggers.match(/<[A-Za-z]+Trigger(?:\s|>)/gi) || []).length !== 1) return false;
      const expectedExec = one(one(expected, 'Actions')!, 'Exec')!;
      const expectedSettings = one(expected, 'Settings')!;
      const equal = (a: string, b: string, tags: string[]) => tags.every(tag => value(a, tag) === value(b, tag));
      if (value(registration, 'Description') !== this.name || !equal(exec, expectedExec, ['Command', 'Arguments']) || value(principal, 'LogonType') !== 'InteractiveToken' || value(principal, 'RunLevel') !== 'LeastPrivilege' || value(trigger, 'Enabled') !== 'true' || !equal(settings, expectedSettings, ['MultipleInstancesPolicy', 'DisallowStartIfOnBatteries', 'StopIfGoingOnBatteries', 'ExecutionTimeLimit', 'Interval', 'Count']) || (value(settings, 'Enabled') !== null && value(settings, 'Enabled') !== 'true')) return false;
      if (this.options.job === 'health' && (value(trigger, 'Interval') !== 'PT30M' || value(trigger, 'StartBoundary') !== '2020-01-01T00:00:00' || value(trigger, 'Duration') !== null || value(trigger, 'EndBoundary') !== null || ![null, 'PT0S'].includes(value(trigger, 'RandomDelay')))) return false;
      const users = [value(principal, 'UserId'), ...(this.options.job === 'health' ? [] : [value(trigger, 'UserId')])];
      if (users.every(user => user?.toLowerCase() === this.options.user.toLowerCase())) return true;
      const who = this.options.runner('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
      const match = who.code === 0 ? who.out.trim().match(/^"([^"\r\n]+)","(S-1-(?:\d+-)*\d+)"$/i) : null;
      const account = match?.[1].toLowerCase(), wanted = this.options.user.toLowerCase();
      return !!match && (account === wanted || account?.split('\\').pop() === wanted) && users.every(user => user?.toLowerCase() === match[2].toLowerCase());
    }
    const header = `gui/${this.options.uid}/${this.name} = {`;
    const block = output.match(/(?:^|\n)\s*arguments = \{\s*\n([\s\S]*?)\n\s*\}/);
    const args = block?.[1].split(/\r?\n/).map(line => line.trim());
    return output.split(/\r?\n/, 1)[0].trim() === header && !!args && args.length === this.args.length && args.every((arg, i) => arg === this.args[i]);
  }
  status(): Result {
    const unavailable = this.unsupported(); if (unavailable) return unavailable;
    const row: Job = { job: this.name, loaded: null, lastRun: null, lastExit: null, nextRun: null };
    try {
      const q = this.query(); row.raw = q.out || q.err;
      if (q.code !== 0 && !this.absent(q)) return this.result('ERROR', q.err || q.out || 'Scheduler query failed', [row]);
      row.loaded = q.code === 0;
      if (row.loaded && this.options.platform === 'darwin') {
        const exit = q.out.match(/last exit (?:code|status)\s*[=:]\s*(-?\d+)/i);
        row.lastExit = exit ? Number(exit[1]) : null;
      }
      if (row.loaded && this.options.platform === 'win32') {
        const script = `Get-ScheduledTaskInfo -TaskName '${this.name}' | Select-Object LastRunTime,LastTaskResult,NextRunTime | ConvertTo-Json -Compress`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const info = this.options.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
        if (info.code !== 0) return this.result('STATUS', info.err || info.out || 'Task metadata unavailable', [row]);
        try {
          const data: unknown = JSON.parse(info.out);
          if (data && typeof data === 'object') {
            const d = data as Record<string, unknown>;
            row.lastRun = typeof d.LastRunTime === 'string' ? d.LastRunTime : null;
            row.nextRun = typeof d.NextRunTime === 'string' ? d.NextRunTime : null;
            row.lastExit = typeof d.LastTaskResult === 'number' ? d.LastTaskResult : null;
          }
        } catch { return this.result('STATUS', 'Task metadata unavailable', [row]); }
      }
      return this.result('STATUS', undefined, [row]);
    } catch (e) { return this.result('ERROR', String(e), [row]); }
  }
  install(dryRun = false, enabled = true): Result {
    const unavailable = this.unsupported(); if (unavailable) return unavailable;
    if (!enabled) return this.result('INSTALLED', 'Scheduler disabled');
    if (dryRun) return { ...this.result('DRY_RUN', `Install ${this.name}`), plan: { path: this.path, definition: this.definition() } };
    try {
      if (unsafeLink(this.options.home) || unsafeLink(this.options.userHome) || unsafeLink(this.serviceDir) || unsafeLink(this.definitionDir) || unsafeLink(this.manifest) || unsafeLink(this.path)) return this.result('CONFLICT', 'Scheduler path is a symbolic link');
      mkdirSync(this.serviceDir, { recursive: true });
      return withLock(this.manifest + '.lock', () => {
      if (unsafeLink(this.options.home) || unsafeLink(this.options.userHome) || unsafeLink(this.serviceDir) || unsafeLink(this.definitionDir) || unsafeLink(this.manifest) || unsafeLink(this.path)) return this.result('CONFLICT', 'Scheduler path is a symbolic link');
      const existing = this.read();
      if (existing && existsSync(this.path) && readFileSync(this.path, 'utf8') !== existing.definition) return this.result('CONFLICT', 'Installed definition was changed');
      if (!existing && (existsSync(this.path) || existsSync(this.manifest))) return this.result('CONFLICT', 'Definition or ownership record already exists');
      const q = this.query();
      if (q.code !== 0 && !this.absent(q)) return this.result('ERROR', q.err || q.out);
      if (q.code === 0 && (!existing || !this.matches(q.out))) return this.result('CONFLICT', 'A different scheduler job already exists');
      if (!existing) {
        if (this.options.platform === 'darwin') mkdirSync(posix.join(this.options.userHome, 'Library', 'LaunchAgents'), { recursive: true });
        const record: Manifest = { platform: this.options.platform, job: this.name, path: this.path, definition: this.definition() };
        writeFileSync(this.manifest, JSON.stringify(record), { flag: 'wx' });
      }
      if (!existsSync(this.path)) writeFileSync(this.path, this.definition(), { flag: 'wx' });
      if (enabled && q.code !== 0) {
        const r = this.options.platform === 'darwin' ? this.options.runner('launchctl', ['bootstrap', `gui/${this.options.uid}`, this.path]) : this.options.runner('schtasks', ['/Create', '/TN', this.name, '/XML', this.path]);
        if (r.code !== 0) return this.result('ERROR', r.err || r.out || 'Scheduler install failed');
      }
      if (this.options.platform === 'win32') {
        const run = this.options.runner('schtasks', ['/Run', '/TN', this.name]);
        if (run.code !== 0) return this.result('ERROR', run.err || run.out || 'Scheduler start failed');
      }
      return this.result('INSTALLED');
      });
    } catch (e) { return this.result('ERROR', String(e)); }
  }
  uninstall(dryRun = false, missingOkay = false): Result {
    const unavailable = this.unsupported(); if (unavailable) return unavailable;
    if (dryRun) return { ...this.result('DRY_RUN', `Remove ${this.name} if owned`), plan: { path: this.path, definition: this.definition() } };
    try {
      if (unsafeLink(this.options.home) || unsafeLink(this.options.userHome) || unsafeLink(this.serviceDir) || unsafeLink(this.definitionDir) || unsafeLink(this.manifest) || unsafeLink(this.path)) return this.result('CONFLICT', 'Scheduler path is a symbolic link');
      mkdirSync(this.serviceDir, { recursive: true });
      return withLock(this.manifest + '.lock', () => {
      if (unsafeLink(this.options.home) || unsafeLink(this.options.userHome) || unsafeLink(this.serviceDir) || unsafeLink(this.definitionDir) || unsafeLink(this.manifest) || unsafeLink(this.path)) return this.result('CONFLICT', 'Scheduler path is a symbolic link');
      const m = this.read();
      if (!m) {
        if (!missingOkay) return this.result('CONFLICT', 'No ownership record');
        const q = this.query();
        return this.absent(q) ? this.result('UNINSTALLED') : this.result(q.code === 0 ? 'CONFLICT' : 'ERROR', 'No ownership record; scheduler job preserved');
      }
      if (existsSync(this.path) && readFileSync(this.path, 'utf8') !== m.definition) return this.result('CONFLICT', 'Installed definition was changed');
      const q = this.query();
      if (q.code !== 0 && !this.absent(q)) return this.result('ERROR', q.err || q.out);
      if (q.code === 0) {
        if (!this.matches(q.out)) return this.result('CONFLICT', 'Scheduler job does not match ownership record');
        if (this.options.platform === 'win32') {
          const end = this.options.runner('schtasks', ['/End', '/TN', this.name]);
          if (end.code !== 0 && !/\b(?:not currently running|not running)\b/i.test(end.err + ' ' + end.out)) return this.result('ERROR', end.err || end.out || 'Scheduler stop failed');
        }
        const r = this.options.platform === 'darwin' ? this.options.runner('launchctl', ['bootout', `gui/${this.options.uid}/${this.name}`]) : this.options.runner('schtasks', ['/Delete', '/TN', this.name, '/F']);
        if (r.code !== 0) return this.result('ERROR', r.err || r.out || 'Scheduler removal failed');
      }
      if (existsSync(this.path)) unlinkSync(this.path);
      unlinkSync(this.manifest);
      return this.result('UNINSTALLED');
      });
    } catch (e) { return this.result('ERROR', String(e)); }
  }
}
