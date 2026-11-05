// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { statfsSync } from 'node:fs';
import { Lease } from '../lease.js';
import { Messages, nameKey } from '../messages.js';
import { WakeWatch, type Worker } from './wake.js';

/** Reads the existing lease heartbeat; health never renews or acknowledges it. */
export class Health {
  constructor(readonly home: string, readonly lease: Lease, readonly messages: Messages, readonly reader: string,
    readonly workers: () => Worker[], readonly deadmanSeconds: number,
    readonly now = () => Date.now() / 1000,
    readonly diskFree = () => { const s = statfsSync(home); return s.bavail * s.bsize; }) {}
  tick(): Record<string, unknown> {
    const now = this.now(), state = this.lease.load();
    const age = typeof state.heartbeat === 'number' && Number.isFinite(state.heartbeat) ? Math.max(0, now - state.heartbeat) : null;
    const answered = new Set(this.messages.all().filter(m => m.kind === 'ANSWER').map(m => m.reply_to));
    const workers = this.workers();
    const health = { ts: new Date(now * 1000).toISOString(), heartbeat_age_seconds: age,
      open_questions: this.messages.inbox(this.reader).filter(m => m.kind === 'QUESTION' && nameKey(m.to) === nameKey(this.reader) && !answered.has(m.id)).map(m => m.id),
      disk_free_bytes: this.diskFree(), worker_count: workers.filter(w => w.state === 'RUNNING').length,
      stale: age === null || age > this.deadmanSeconds };
    new WakeWatch(this.home, this.messages, this.reader, () => workers).tick(health);
    return health;
  }
}
