import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Lease } from '../src/lease.js';
import { Messages } from '../src/messages.js';
import { Health } from '../src/service/health.js';
import { WakeWatch, snapshot } from '../src/service/wake.js';
import { tmp } from './_helpers.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup() {
  const home = tmp(); roots.push(home);
  const messages = new Messages(join(home, 'messages.jsonl'), join(home, 'cursors'));
  const lease = new Lease(join(home, 'lease.json'));
  lease.run('acquire', 'session', { now: 100 });
  return { home, messages, lease, health: (now: number) => new Health(home, lease, messages, 'lead', () => [{ name: 'w', run: '1:1', state: 'RUNNING' }], 60, () => now, () => 1234).tick() };
}
const events = (home: string) => readFileSync(join(home, 'wake', 'events.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
it('records existing heartbeat, unanswered addressed questions, disk and running workers without acknowledging inbox', () => {
  const { home, messages, health } = setup();
  const q = messages.send('w', 'LEAD', 'QUESTION', 'answered');
  messages.send('lead', 'w', 'ANSWER', 'reply', q.id);
  const open = messages.send('w', 'lead', 'QUESTION', 'open');
  messages.send('w', 'other', 'QUESTION', 'other');
  messages.send('w', '*', 'QUESTION', 'broadcast');
  expect(health(150)).toMatchObject({ heartbeat_age_seconds: 50, open_questions: [open.id], disk_free_bytes: 1234, worker_count: 1, stale: false });
  expect(JSON.parse(readFileSync(join(home, 'wake', 'health.json'), 'utf8')).owner).toBe('orch-health-v1');
  expect(messages.pending('lead')).toHaveLength(3);
});
it('alerts once per stale period across restarts and append-before-cursor interruption', () => {
  const { home, lease, messages, health } = setup();
  health(200);
  const cursor = join(home, 'wake', 'cursor.json');
  writeFileSync(cursor, JSON.stringify({ seq: 0 }));
  health(220);
  // A newer heartbeat that is still stale does not start a new period.
  lease.run('renew', 'session', { now: 120 }); health(240);
  expect(events(home).filter(e => e.kind === 'DEADMAN')).toHaveLength(1);
  lease.run('renew', 'session', { now: 250 }); health(260); health(400);
  expect(events(home).filter(e => e.kind === 'DEADMAN')).toHaveLength(2);
  messages.send('w', 'lead', 'DONE', 'done');
  new WakeWatch(home, messages, 'lead', () => []).tick();
  health(500);
  expect(events(home).map(e => e.kind)).toEqual(['DEADMAN', 'DEADMAN', 'DONE']);
});
it('treats a missing heartbeat as stale and preserves unowned or linked health records', () => {
  const { home, lease, health } = setup(); rmSync(lease.path);
  expect(health(200)).toMatchObject({ stale: true, heartbeat_age_seconds: null });
  const p = join(home, 'wake', 'health.json'); rmSync(p);
  const outside = join(home, 'note'); writeFileSync(outside, 'user'); symlinkSync(outside, p);
  expect(() => health(200)).toThrow(); expect(readFileSync(outside, 'utf8')).toBe('user');
  rmSync(p); writeFileSync(p, '{}'); expect(() => health(200)).toThrow();
});
it('refuses corrupt deadman state without changing the event log', () => {
  const { home, health } = setup(); health(200);
  const log = readFileSync(join(home, 'wake', 'events.log'), 'utf8');
  writeFileSync(join(home, 'wake', 'cursor.json'), JSON.stringify({ seq: 0, deadman: 'foreign', deadman_period: -1 }));
  expect(() => health(300)).toThrow('invalid deadman cursor');
  expect(readFileSync(join(home, 'wake', 'events.log'), 'utf8')).toBe(log);
});

it('publishes recovery only after the durable cursor commits', () => {
  const { home, health, messages } = setup(); health(200);
  const watch = new WakeWatch(home, messages, 'lead', () => [], (path, data) => {
    if (path.endsWith('cursor.json')) throw new Error('cursor commit interrupted');
    snapshot(path, data);
  });
  expect(() => watch.tick({ stale: false })).toThrow('cursor commit interrupted');
  expect(JSON.parse(readFileSync(join(home, 'wake', 'health.json'), 'utf8')).stale).toBe(true);
  // Commit recovery, then observe the next stale period.
  new WakeWatch(home, messages, 'lead', () => []).tick({ stale: false }); health(400);
  expect(events(home).filter(e => e.kind === 'DEADMAN')).toHaveLength(2);
});
