// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Load governor: one sample per call, tiered with hysteresis, never kills anything.
 *
 * Signals: load_ratio = 1-minute load average / CPU count (portable), swap_pct (Linux and
 * macOS; absent elsewhere) and, only when [load] temp_command is set, temp_c (the command must
 * print one number in degrees C). Missing signals are skipped, never guessed.
 *
 * Tiers NORMAL < BUSY < HIGH < CRITICAL. A tier is entered after 2 consecutive samples at or
 * above it and left after 3 consecutive samples below it minus a margin. `orch worker start`
 * refuses new workers while the tier is in [workers] block_tiers. With [load] act = true and a
 * non-empty renice_pattern, HIGH and CRITICAL lower the priority of matching processes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, getPriority, loadavg, setPriority } from "node:os";
import { dirname } from "node:path";
import { dumps } from "./pyjson.js";
import { atomicWrite, isPlainObject, which } from "./util.js";

export const TIERS = ["NORMAL", "BUSY", "HIGH", "CRITICAL"];
const SIGNALS = ["load_ratio", "swap_pct", "temp_c"] as const;
const DOWN_MARGIN: Record<string, number> = { load_ratio: 0.1, swap_pct: 5.0, temp_c: 5.0 };
const UP_N = 2;
const DOWN_N = 3;
const HIST_N = 5;
const RENICE: Record<string, number> = { HIGH: 10, CRITICAL: 19 };

export type Sample = Record<string, number | null | undefined>;
export type Thresholds = [string, Record<string, number>][];

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function thresholds(cfg: Record<string, any>): Thresholds {
  const l = cfg.load ?? {};
  return [["CRITICAL", l.critical ?? {}], ["HIGH", l.high ?? {}], ["BUSY", l.busy ?? {}]];
}

export function level(sample: Sample, th: Thresholds, down = false): string {
  for (const [tier, lims] of th) {
    for (const key of SIGNALS) {
      const lim = lims[key];
      const v = sample[key];
      if (lim !== undefined && lim !== null && v !== undefined && v !== null && v >= lim - (down ? DOWN_MARGIN[key] : 0)) return tier;
    }
  }
  return "NORMAL";
}

const idx = (t: string) => TIERS.indexOf(t);

export function nextTier(cur: string, hist: Sample[], th: Thresholds): string {
  if (hist.length >= UP_N) {
    const up = hist.slice(-UP_N).map((s) => level(s, th)).reduce((a, b) => (idx(b) < idx(a) ? b : a));
    if (idx(up) > idx(cur)) return up;
  }
  if (hist.length >= DOWN_N && cur !== "NORMAL") {
    const relaxed = hist.slice(-DOWN_N).map((s) => level(s, th, true)).reduce((a, b) => (idx(b) > idx(a) ? b : a));
    if (idx(relaxed) < idx(cur)) return relaxed;
  }
  return cur;
}

export function swapPct(): number | null {
  try {
    let tot: number;
    let used: number;
    if (process.platform === "darwin") {
      const exe = which("sysctl") ?? "/usr/sbin/sysctl"; // /usr/sbin is often not on PATH
      const t = spawnSync(exe, ["vm.swapusage"], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
      tot = parseFloat(/total = ([\d.]+)M/.exec(t)![1]);
      used = parseFloat(/used = ([\d.]+)M/.exec(t)![1]);
    } else {
      const mi: Record<string, string> = {};
      for (const l of readFileSync("/proc/meminfo", "utf8").split("\n")) {
        const i = l.indexOf(":");
        if (i >= 0) mi[l.slice(0, i)] = l.slice(i + 1);
      }
      tot = parseFloat(mi.SwapTotal.trim().split(/\s+/)[0]);
      used = tot - parseFloat(mi.SwapFree.trim().split(/\s+/)[0]);
    }
    if (Number.isNaN(tot) || Number.isNaN(used)) return null;
    return tot > 0 ? round((100.0 * used) / tot, 1) : 0.0;
  } catch {
    return null;
  }
}

export function tempC(command: string | undefined | null): number | null {
  if (!command) return null;
  try {
    const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 15_000 });
    const m = /-?\d+(?:\.\d+)?/.exec(r.stdout ?? "");
    return m ? round(parseFloat(m[0]), 1) : null;
  } catch {
    return null;
  }
}

export function takeSample(cfg: Record<string, any>): Sample {
  let ratio: number | null = null;
  try {
    ratio = round(loadavg()[0] / (cpus().length || 1), 2);
  } catch {
    ratio = null;
  }
  return { ts: round(Date.now() / 1000, 1), load_ratio: ratio, swap_pct: swapPct(), temp_c: tempC((cfg.load ?? {}).temp_command ?? "") };
}

export function reniceMatching(pattern: string, target: number): number {
  const out = spawnSync("ps", ["-Ao", "pid=,uid=,args="], { encoding: "utf8" }).stdout ?? "";
  const me = process.pid;
  const uid = process.getuid ? process.getuid() : -1;
  const re = new RegExp(pattern);
  let n = 0;
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number(m[2]) !== uid || pid === me || !re.test(m[3])) continue;
    try {
      if (getPriority(pid) < target) {
        setPriority(pid, target);
        n += 1;
      }
    } catch { /* gone or not ours */ }
  }
  return n;
}

export function readState(path: string): Record<string, any> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(v) ? v : {};
  } catch {
    return {};
  }
}

/** Take (or accept) one sample, advance the tier, persist state atomically, return it. */
export function step(cfg: Record<string, any>, statePath: string, sample?: Sample | null): Record<string, any> {
  const th = thresholds(cfg);
  const prev = readState(statePath);
  const s = sample && Object.keys(sample).length ? sample : takeSample(cfg);
  const hist: Sample[] = [...(Array.isArray(prev.history) ? prev.history : []).slice(-(HIST_N - 1)), s];
  const cur = TIERS.includes(prev.tier) ? prev.tier : "NORMAL";
  const tier = nextTier(cur, hist, th);
  let reniced = 0;
  const l = cfg.load ?? {};
  if (l.act && tier in RENICE && l.renice_pattern) reniced = reniceMatching(l.renice_pattern, RENICE[tier]);
  const state = { ...s, tier, previous_tier: cur, raw_level: level(s, th), reniced, history: hist };
  if (!existsSync(dirname(statePath))) mkdirSync(dirname(statePath), { recursive: true });
  atomicWrite(statePath, dumps(state, 1));
  return state;
}
