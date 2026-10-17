// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/** Weekly, check-only update state. This module never installs packages. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { checkLatest } from "./update.js";

export const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Claims abandoned for two check intervals may be reclaimed. */
export const NOTICE_CLAIM_STALE_MS = 2 * CHECK_INTERVAL_MS;
export const AUTO_UPDATE_COMMANDS = ["agents", "lease status", "doctor"] as const;

interface State {
  schema: 1;
  last_check_at: string;
  pending_notice?: string;
  backup?: string;
  log?: string;
}

function path(home: string, name: string): string { return join(home, name); }
function validText(v: unknown): v is string {
  return typeof v === "string" && !/[\uD800-\uDFFF]/u.test(v) && v.length <= 512;
}
function readState(home: string): State | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path(home, "update-state.json"), "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const s = v as Record<string, unknown>;
    if (s.schema !== 1 || !validText(s.last_check_at) || !Number.isFinite(Date.parse(s.last_check_at))) return null;
    if (s.pending_notice !== undefined && !validText(s.pending_notice)) return null;
    return s as unknown as State;
  } catch { return null; }
}
function atomic(home: string, name: string, text: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = path(home, name);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, target);
}
function writeState(home: string, state: State): void { atomic(home, "update-state.json", `${JSON.stringify(state)}\n`); }

export function autoUpdateEnabled(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCH_AUTO_UPDATE !== "0" && !existsSync(path(home, "update-auto"));
}
export function setAutoUpdate(home: string, enabled: boolean): void {
  if (enabled) rmSync(path(home, "update-auto"), { force: true });
  else atomic(home, "update-auto", "off\n");
}
export function isAutoUpdateDue(last: unknown, now = Date.now()): boolean {
  const time = typeof last === "string" ? Date.parse(last) : NaN;
  return !Number.isFinite(time) || time > now + 24 * 60 * 60 * 1000 || now - time >= CHECK_INTERVAL_MS;
}

function isoWeek(date: Date): { year: number; week: number; start: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const firstDay = first.getUTCDay() || 7;
  first.setUTCDate(first.getUTCDate() - firstDay + 1);
  const week = Math.floor((d.getTime() - first.getTime()) / CHECK_INTERVAL_MS) + 1;
  return { year, week, start: first.getTime() + (week - 1) * CHECK_INTERVAL_MS };
}
function weekStart(year: number, week: number): number | null {
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const start = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000 + (week - 1) * CHECK_INTERVAL_MS;
  const actual = isoWeek(new Date(start));
  return actual.year === year && actual.week === week ? start : null;
}
function weeklyLock(home: string, now: Date): boolean {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const current = isoWeek(now);
  for (const name of readdirSync(home)) {
    const match = /^update-lock-(\d{4})-(\d{2})$/.exec(name);
    if (!match) continue;
    const start = weekStart(Number(match[1]), Number(match[2]));
    if (start !== null && current.start - start > 2 * CHECK_INTERVAL_MS) rmSync(path(home, name), { force: true });
  }
  try {
    const fd = openSync(path(home, `update-lock-${current.year}-${String(current.week).padStart(2, "0")}`), "wx", 0o600);
    closeSync(fd);
    return true;
  } catch { return false; }
}

export async function runAutoUpdate(home: string, running: string, options: {
  now?: () => Date;
  address?: string;
  afterCheck?: () => void | Promise<void>;
  holder?: () => void | Promise<void>;
} = {}): Promise<boolean> {
  if (!autoUpdateEnabled(home)) return false;
  const now = options.now?.() ?? new Date();
  const old = readState(home);
  if (!isAutoUpdateDue(old?.last_check_at, now.getTime()) || !weeklyLock(home, now)) return false;
  await options.holder?.();
  if (!autoUpdateEnabled(home)) return false;
  const state: State = { ...(old ?? {}), schema: 1, last_check_at: now.toISOString() };
  writeState(home, state);
  const result = await checkLatest(running, options.address);
  await options.afterCheck?.();
  if (!autoUpdateEnabled(home)) return false;
  if (result.kind === "newer") {
    state.pending_notice = `orch update available: ${running} -> ${result.offered} (nothing was installed; run npm i -g orch-os@${result.offered} to upgrade)`;
    writeState(home, state);
  }
  return true;
}

function ownClaim(claim: string, token: string): void {
  try { if (readFileSync(claim, "utf8") === token) rmSync(claim); } catch { /* another holder owns it */ }
}
function acquireClaim(home: string, now: number): { claim: string; token: string } | null {
  const claim = path(home, "update-notice.claim");
  const token = randomBytes(16).toString("hex");
  try { writeFileSync(claim, token, { flag: "wx", mode: 0o600 }); return { claim, token }; } catch { /* inspect stale claim */ }
  let staleToken: string;
  try {
    if (now - statSync(claim).mtimeMs <= NOTICE_CLAIM_STALE_MS) return null;
    staleToken = readFileSync(claim, "utf8");
  } catch { return null; }
  const stale = `${claim}.stale-${randomBytes(8).toString("hex")}`;
  try { renameSync(claim, stale); } catch { return null; }
  try {
    if (readFileSync(stale, "utf8") === staleToken) rmSync(stale);
    else if (!existsSync(claim)) renameSync(stale, claim);
  } catch { /* a later reclaim will handle the artifact */ }
  try { writeFileSync(claim, token, { flag: "wx", mode: 0o600 }); return { claim, token }; } catch { return null; }
}

export function consumeNotice(home: string, now = Date.now()): string | null {
  if (!autoUpdateEnabled(home)) return null;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const held = acquireClaim(home, now);
  if (!held) return null;
  try {
    if (!autoUpdateEnabled(home)) return null;
    const state = readState(home);
    if (!state?.pending_notice) return null;
    const notice = state.pending_notice;
    delete state.pending_notice;
    writeState(home, state);
    return notice;
  } finally { ownClaim(held.claim, held.token); }
}

export function statusText(home: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const state = readState(home);
  const enabled = autoUpdateEnabled(home, env);
  const source = env.ORCH_AUTO_UPDATE === "0" ? "environment" : existsSync(path(home, "update-auto")) ? "file" : "default";
  const last = state?.last_check_at ?? "never";
  const due = last === "never" || isAutoUpdateDue(last, now) ? "due" : new Date(Date.parse(last) + CHECK_INTERVAL_MS).toISOString();
  let text = `auto update: ${enabled ? "on" : "off"} (${source})\nlast check: ${last}\nnext due: ${due}`;
  if (state?.backup && validText(state.backup)) text += `\nsettings backup kept: ${basename(state.backup.replace(/\\/g, "/"))}`;
  if (state?.log && validText(state.log)) text += `\ndiagnostic: ${basename(state.log.replace(/\\/g, "/"))}`;
  return `${text}\n`;
}

export function isAllowlisted(argv: string[]): boolean {
  const key = argv.length === 1 ? argv[0] : argv.length === 2 && argv[0] === "lease" && argv[1] === "status" ? "lease status" : undefined;
  return (AUTO_UPDATE_COMMANDS as readonly string[]).includes(key ?? "");
}
export function scheduleAutoUpdate(cli: string, home: string): void {
  if (!autoUpdateEnabled(home)) return;
  const child = spawn(process.execPath, [cli, "update", "auto", "--background"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}
