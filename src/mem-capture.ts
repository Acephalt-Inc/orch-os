// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { MemError, type Mem, type MemEntry } from "./mem.js";
import type { TaskRow } from "./tasks.js";
import { show as showResume } from "./resume/store.js";
import type { ResumeRecord } from "./resume/schema.js";
import { isFullyQualifiedWindowsPath } from "./util.js";

type Hook = { hook_event_name: string; session_id: string; transcript_path: string; cwd?: string };
type Options = { platform?: NodeJS.Platform; read?: (path: string) => string; resumeShow?: (cwd: string) => ResumeRecord | undefined; now?: Date };

const display = (s: string, max: number) => s.replace(/<system-reminder\b[^>]*>[\s\S]*?(?:<\/system-reminder>|$)/gi, "")
  .replace(/<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/gi, "")
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function nativeAbsolute(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? isFullyQualifiedWindowsPath(path) : posix.isAbsolute(path) && !isFullyQualifiedWindowsPath(path);
}

function parseHook(input: unknown, platform: NodeJS.Platform): Hook {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MemError("hook input must be a JSON object");
  const x = input as Record<string, unknown>;
  if (x.hook_event_name !== "SessionEnd" && x.hook_event_name !== "PreCompact") throw new MemError("unsupported hook event");
  if (typeof x.session_id !== "string" || !x.session_id || x.session_id.length > 1024) throw new MemError("invalid session id");
  if (typeof x.transcript_path !== "string" || !nativeAbsolute(x.transcript_path, platform)) throw new MemError("transcript path must be native absolute path");
  if (x.cwd !== undefined && (typeof x.cwd !== "string" || !nativeAbsolute(x.cwd, platform))) throw new MemError("workspace path must be native absolute path");
  return x as Hook;
}

function requests(jsonl: string): string[] {
  const found: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let x: any;
    try { x = JSON.parse(line); } catch { throw new MemError("transcript is not valid JSONL"); }
    if (x?.type !== "user" || x?.isMeta === true || x?.isCompactSummary === true || x?.message?.role !== "user" || x.message.isMeta === true || x.message.isCompactSummary === true) continue;
    const content = x.message.content;
    const parts = typeof content === "string" ? [content] : Array.isArray(content)
      ? content.filter((b: any) => b && b.type === "text" && typeof b.text === "string" && b.isMeta !== true).map((b: any) => b.text) : [];
    const clean = display(parts.join(" "), 500);
    if (clean) found.push(clean);
    if (found.length >= 10) break;
  }
  return found;
}

/** Parse one Claude hook event and create at most one immutable draft for its session. */
export function captureHook(input: unknown, mem: Mem, tasks: { list(): TaskRow[] }, options: Options = {}): MemEntry {
  const platform = options.platform ?? process.platform;
  const hook = parseHook(input, platform);
  const digest = createHash("sha256").update(hook.session_id).digest("hex");
  const id = `session-${digest}`;
  try {
    const s = lstatSync(mem.file(id));
    if (!s.isFile() || s.isSymbolicLink()) throw new MemError("session draft name is occupied");
  } catch (error) {
    if (error instanceof MemError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MemError("session draft is unavailable");
  }
  const existing = mem.get(id);
  if (existing) {
    if (existing.name !== id || existing.session_hash !== digest) throw new MemError("session draft name is occupied");
    return existing;
  }
  let next = "";
  if (hook.cwd) {
    try { next = (options.resumeShow ? options.resumeShow(hook.cwd) : showResume(hook.cwd))?.note?.next_step ?? ""; }
    catch { throw new MemError("resume workspace is unsafe or unavailable"); }
  }
  let text: string;
  try {
    if (!options.read && statSync(hook.transcript_path).size > 8_000_000) throw new MemError("transcript exceeds 8 MB");
    text = (options.read ?? ((p) => readFileSync(p, "utf8")))(hook.transcript_path);
  } catch (error) {
    if (error instanceof MemError) throw error;
    throw new MemError("transcript is unavailable");
  }
  if (Buffer.byteLength(text) > 8_000_000) throw new MemError("transcript exceeds 8 MB");
  const user = requests(text);
  let rows: TaskRow[];
  try { rows = tasks.list().filter((r) => r.status !== "RELEASED"); }
  catch { throw new MemError("task registry is unavailable"); }
  const body = [
    `Captured UTC: ${(options.now ?? new Date()).toISOString().slice(0, 10)}`,
    "User requests (unverified transcript text):",
    ...user.map((s, i) => `${i + 1}. ${s}`),
    "Open tasks (registry status at capture):",
    ...rows.slice(0, 30).map((r) => `- ${display(r.id, 80)}: ${display(r.status, 32)}`),
    ...(next ? [`Unverified next step (private resume note): ${display(next, 300)}`] : []),
  ].join("\n");
  return mem.draft(id, user[0]?.slice(0, 180) ?? "Session requests unavailable", body, digest, options.now);
}
