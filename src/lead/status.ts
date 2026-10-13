// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * What is on disk: the manifest (a record of intent, never of completion), the anchors, the
 * record of the directories install created, the record that install finished, and the state of
 * each of the 20 payload paths. Everything here reads; nothing here writes.
 *
 * A payload file is owned only when it is the same file as its anchor (same device and inode)
 * and the manifest lists it; equal bytes at another inode are a foreign file. A path that passes
 * through a folder that is now a link is never opened. The report is a snapshot: another program
 * can change the files right after they are read.
 *
 * The record that install finished changes one thing only: whether the recorded installer
 * process id is asked about. It never makes a file owned and never makes a result INSTALLED by
 * itself; that is always read from the files.
 */
import {
  BIG, errorCode, type FileRead, type LeadEnv, LeadError, MANIFEST_CAP, FILE_CAP, packHash, readBounded, reviewedRows, sha256,
} from "./pack.js";
import {
  COMPLETE, DIRECTORIES, type Host, hostDirs, HOSTS, insideWorkspace, isLiteralRowPath, MANIFEST, MANIFEST_TMP, OBJECTS_DIR, PAYLOAD_COUNT, STATE_DIR,
} from "./paths.js";

export type RowState = "OWNED_MATCH" | "OWNED_CHANGED" | "MISSING" | "FOREIGN" | "UNVERIFIABLE";
export type Aggregate = "NOT_INSTALLED" | "INSTALLED" | "PARTIAL" | "CONFLICT" | "UNVERIFIABLE_PREPARATION" | "BUSY";
export type AnchorState = "OK" | "MISSING" | "MISMATCH" | "NOT_FILE" | "UNREADABLE";
export type Liveness = "DEAD" | "ALIVE" | "UNKNOWN";
/** Why a row has its state; the command line turns each into one fixed phrase. */
export type RowWhy = "" | "EDITED" | "OTHER_FILE" | "NOT_FILE" | "NO_MANIFEST" | "NO_ANCHOR" | "BAD_ANCHOR" | "UNSTABLE" | "UNREADABLE" | "LINKED";
export type RecordState = "ABSENT" | "VALID" | "INVALID";

export interface ManifestRow {
  path: string;
  sha256: string;
  anchor: string;
}

export interface Manifest {
  schema: 1;
  host: Host;
  workspace: string;
  pack: string;
  pid: number;
  rows: ManifestRow[];
}

export function manifestRows(host: Host): ManifestRow[] {
  return reviewedRows(host).map((r) => ({ path: r.dest, sha256: r.sha256, anchor: r.anchor }));
}

/** The one byte form of a manifest. Only the workspace and the installer's process id vary. */
export function serializeManifest(host: Host, workspace: string, pid: number): Buffer {
  const rows = manifestRows(host);
  const head = { schema: 1, host, workspace, pack: packHash(rows.map((r) => ({ dest: r.path, sha256: r.sha256 }))), pid };
  const lines = rows.map((r) => `    ${JSON.stringify({ path: r.path, sha256: r.sha256, anchor: r.anchor })}`);
  const text = `${JSON.stringify(head).slice(0, -1)},"rows":[\n${lines.join(",\n")}\n]}\n`;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MANIFEST_CAP) throw new LeadError(`the manifest would be larger than ${MANIFEST_CAP} bytes`, "io", "TOO_LARGE");
  return bytes;
}

export type ManifestCheck = { ok: true; manifest: Manifest } | { ok: false; reason: string };

/**
 * Accept only the exact bytes this version writes for this host and workspace. Anything else
 * (another schema, host or workspace, other hashes or paths, extra or repeated keys, another
 * layout) is refused before any path in it is used.
 */
export function checkManifest(bytes: Buffer, host: Host, workspace: string): ManifestCheck {
  if (bytes.length > MANIFEST_CAP) return { ok: false, reason: "it is too large" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "it is not UTF-8 JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "it is not a JSON object" };
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) return { ok: false, reason: "its schema is not 1" };
  if (typeof v.host !== "string" || !(HOSTS as readonly string[]).includes(v.host)) return { ok: false, reason: "its host is unknown" };
  if (v.host !== host) return { ok: false, reason: `it records host ${v.host}` };
  if (v.workspace !== workspace) return { ok: false, reason: "it records another workspace" };
  if (typeof v.pid !== "number" || !Number.isSafeInteger(v.pid) || v.pid <= 0) return { ok: false, reason: "its process id is not a positive integer" };
  if (!Array.isArray(v.rows) || v.rows.length !== PAYLOAD_COUNT) return { ok: false, reason: `it does not have exactly ${PAYLOAD_COUNT} rows` };
  for (const row of v.rows as unknown[]) {
    const r = row as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || typeof r.path !== "string" || !isLiteralRowPath(r.path)) return { ok: false, reason: "a row path is not a plain relative path" };
  }
  const expected = serializeManifest(host, workspace, v.pid);
  if (!expected.equals(bytes)) return { ok: false, reason: "its rows, hashes or layout are not the ones this version writes" };
  const rows = manifestRows(host);
  return { ok: true, manifest: { schema: 1, host, workspace, pack: packHash(rows.map((r) => ({ dest: r.path, sha256: r.sha256 }))), pid: v.pid, rows } };
}

/** One host directory this install created, with its identity at that moment (decimal text). */
export interface DirRow {
  path: string;
  dev: string;
  ino: string;
}

/** The one byte form of the directories record. It names the manifest it belongs to by hash. */
export function serializeDirectories(manifestSha: string, created: readonly DirRow[]): Buffer {
  const lines = created.map((d) => `    ${JSON.stringify({ path: d.path, dev: d.dev, ino: d.ino })}`);
  return Buffer.from(`{"schema":1,"manifest":"${manifestSha}","created":[${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`, "utf8");
}

/**
 * Accept only the exact bytes this version writes: directories of this host's layout, outermost
 * first, none twice, each with a numeric identity. Returns the rows, or null.
 */
export function checkDirectories(bytes: Buffer, host: Host, manifestSha: string): DirRow[] | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1 || v.manifest !== manifestSha || !Array.isArray(v.created)) return null;
  const allowed = hostDirs(host);
  const rows: DirRow[] = [];
  let last = -1;
  for (const item of v.created as unknown[]) {
    const r = item as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || typeof r.path !== "string" || typeof r.dev !== "string" || typeof r.ino !== "string") return null;
    if (!/^\d{1,20}$/.test(r.dev) || !/^\d{1,20}$/.test(r.ino)) return null;
    const index = allowed.indexOf(r.path);
    if (index <= last) return null;
    last = index;
    rows.push({ path: r.path, dev: r.dev, ino: r.ino });
  }
  return serializeDirectories(manifestSha, rows).equals(bytes) ? rows : null;
}

/** The one byte form of the record that install finished. It names its manifest by hash. */
export function serializeComplete(manifestSha: string): Buffer {
  return Buffer.from(`{"schema":1,"manifest":"${manifestSha}","install":"complete"}\n`, "utf8");
}

export interface RowReport {
  path: string;
  anchor: string;
  state: RowState;
  why: RowWhy;
  anchorState: AnchorState;
  /** Identity of the destination when it was a regular file that could be opened. */
  id: { dev: bigint; ino: bigint } | null;
}

export interface StateReport {
  /** ABSENT: no state directory. INVALID: state without a valid manifest. VALID: manifest accepted. */
  state: "ABSENT" | "INVALID" | "VALID";
  reason: string;
  manifest: Manifest | null;
  manifestFile: FileRead | null;
  rows: RowReport[];
  tmp: "ABSENT" | "SAME_AS_MANIFEST" | "DIFFERENT";
  /** Entries of the state directory this version does not know, relative to the workspace. Never opened. */
  unknown: string[];
  /** The record of the host directories this install created. `file` is set when VALID. */
  directories: { state: RecordState; created: DirRow[]; file: FileRead | null };
  /** The record that install finished. `file` is set when VALID. */
  complete: { state: RecordState; file: FileRead | null };
  /** Answer about the recorded installer process. Null when it was not asked: the install is recorded as finished, or the installer reads its own work. */
  liveness: Liveness | null;
  aggregate: Aggregate;
}

function lstatOrCode(env: LeadEnv, path: string): ReturnType<LeadEnv["fs"]["lstatSync"]> | string {
  try {
    return env.fs.lstatSync(path, BIG);
  } catch (e) {
    return errorCode(e);
  }
}

/**
 * The first folder on the way to `rel` that is not a real directory any more (a link, a junction
 * or a file), relative to the workspace; null when there is none. A folder that does not exist
 * ends the walk: nothing can be behind it.
 */
export function linkOnPath(env: LeadEnv, workspace: string, rel: string): string | null {
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    const st = lstatOrCode(env, insideWorkspace(env.path, workspace, dir));
    if (st === "ENOENT") return null;
    if (typeof st === "string" || !st.isDirectory()) return dir;
  }
  return null;
}

/** A small record file of the state directory: its bytes, or why they cannot be used. */
function readRecord(env: LeadEnv, path: string, deadline: number): FileRead | "ABSENT" | "INVALID" {
  const st = lstatOrCode(env, path);
  if (st === "ENOENT") return "ABSENT";
  if (typeof st === "string" || !st.isFile()) return "INVALID";
  try {
    const file = readBounded(env, path, MANIFEST_CAP, deadline);
    return file.dev === st.dev && file.ino === st.ino ? file : "INVALID";
  } catch (e) {
    if (e instanceof LeadError && e.code === "DEADLINE") throw e;
    return "INVALID";
  }
}

function readAnchor(env: LeadEnv, path: string, expected: string, deadline: number): { state: AnchorState; file: FileRead | null } {
  const st = lstatOrCode(env, path);
  if (st === "ENOENT") return { state: "MISSING", file: null };
  if (typeof st === "string") return { state: "UNREADABLE", file: null };
  if (!st.isFile()) return { state: "NOT_FILE", file: null };
  try {
    const file = readBounded(env, path, FILE_CAP, deadline);
    if (file.dev !== st.dev || file.ino !== st.ino) return { state: "UNREADABLE", file: null };
    return { state: sha256(file.bytes) === expected ? "OK" : "MISMATCH", file };
  } catch (e) {
    if (e instanceof LeadError && e.code === "DEADLINE") throw e;
    return { state: e instanceof LeadError && e.code === "TOO_LARGE" ? "MISMATCH" : "UNREADABLE", file: null };
  }
}

/** State of one payload path. Used with a validated manifest only. */
export function classifyRow(env: LeadEnv, workspace: string, row: ManifestRow, deadline: number): RowReport {
  const dest = insideWorkspace(env.path, workspace, row.path);
  const anchorPath = insideWorkspace(env.path, workspace, `${STATE_DIR}/${row.anchor}`);
  // An anchor below a state folder that is now a link is not read.
  const anchor = linkOnPath(env, workspace, `${STATE_DIR}/${row.anchor}`) === null ? readAnchor(env, anchorPath, row.sha256, deadline) : { state: "UNREADABLE" as AnchorState, file: null };
  const base = { path: row.path, anchor: row.anchor, anchorState: anchor.state, id: null };
  // A destination below a folder that is now a link is not looked at: whatever is there is behind the link.
  if (linkOnPath(env, workspace, row.path) !== null) return { ...base, state: "UNVERIFIABLE", why: "LINKED" };
  const st = lstatOrCode(env, dest);
  if (st === "ENOENT") return { ...base, state: "MISSING", why: "" };
  if (typeof st === "string") return { ...base, state: "UNVERIFIABLE", why: "UNREADABLE" };
  if (!st.isFile()) return { ...base, state: "FOREIGN", why: "NOT_FILE" };
  const id = { dev: st.dev, ino: st.ino };
  if (anchor.state === "MISSING") return { ...base, id, state: "UNVERIFIABLE", why: "NO_ANCHOR" };
  if (!anchor.file) return { ...base, id, state: "UNVERIFIABLE", why: "BAD_ANCHOR" };
  if (anchor.file.dev !== st.dev || anchor.file.ino !== st.ino) return { ...base, id, state: "FOREIGN", why: "OTHER_FILE" };
  let file: FileRead;
  try {
    file = readBounded(env, dest, FILE_CAP, deadline);
  } catch (e) {
    if (e instanceof LeadError && e.code === "DEADLINE") throw e;
    return { ...base, id, state: e instanceof LeadError && e.code === "TOO_LARGE" ? "OWNED_CHANGED" : "UNVERIFIABLE", why: e instanceof LeadError && e.code === "TOO_LARGE" ? "EDITED" : "UNSTABLE" };
  }
  if (file.dev !== st.dev || file.ino !== st.ino) return { ...base, id, state: "UNVERIFIABLE", why: "UNSTABLE" };
  return sha256(file.bytes) === row.sha256 ? { ...base, id, state: "OWNED_MATCH", why: "" } : { ...base, id, state: "OWNED_CHANGED", why: "EDITED" };
}

export function liveness(env: LeadEnv, pid: number): Liveness {
  try {
    env.probe(pid);
    return "ALIVE";
  } catch (e) {
    return errorCode(e) === "ESRCH" ? "DEAD" : errorCode(e) === "EPERM" ? "ALIVE" : "UNKNOWN";
  }
}

const KNOWN_TOP = new Set(["manifest.json", "manifest.tmp", "objects", "directories.json", "complete"]);

function unknownEntries(env: LeadEnv, workspace: string): string[] {
  const out: string[] = [];
  const top = env.path.join(workspace, STATE_DIR);
  for (const name of env.fs.readdirSync(top)) if (!KNOWN_TOP.has(name)) out.push(`${STATE_DIR}/${name}`);
  const objects = env.path.join(workspace, ...OBJECTS_DIR.split("/"));
  const st = lstatOrCode(env, objects);
  if (typeof st !== "string" && st.isDirectory()) {
    for (const name of env.fs.readdirSync(objects)) {
      if (!(/^\d\d$/.test(name) && Number(name) < PAYLOAD_COUNT)) out.push(`${OBJECTS_DIR}/${name}`);
    }
  } else if (st !== "ENOENT") {
    out.push(OBJECTS_DIR);
  }
  return out.sort();
}

/** Rows when no valid manifest exists: nothing is opened, and nothing is called owned. */
function rowsWithoutManifest(env: LeadEnv, workspace: string, host: Host, present: RowState, why: RowWhy): RowReport[] {
  return manifestRows(host).map((row) => {
    const base = { path: row.path, anchor: row.anchor, anchorState: "MISSING" as AnchorState, id: null };
    if (linkOnPath(env, workspace, row.path) !== null) {
      return { ...base, state: "UNVERIFIABLE", why: "LINKED" };
    }
    const st = lstatOrCode(env, insideWorkspace(env.path, workspace, row.path));
    return st === "ENOENT" ? { ...base, state: "MISSING", why: "" } : { ...base, state: present, why };
  });
}

/**
 * Read the state of one workspace for one host. `self` is true only for the installer checking
 * its own work: its own process id is then not a reason to report BUSY.
 */
export function readState(env: LeadEnv, workspace: string, host: Host, deadline: number, self = false): StateReport {
  const empty = {
    manifest: null, manifestFile: null, tmp: "ABSENT" as const, unknown: [], liveness: null,
    directories: { state: "ABSENT" as RecordState, created: [], file: null }, complete: { state: "ABSENT" as RecordState, file: null },
  };
  const stateDir = env.path.join(workspace, STATE_DIR);
  const dirStat = lstatOrCode(env, stateDir);
  if (dirStat === "ENOENT") {
    return { ...empty, state: "ABSENT", reason: "", rows: rowsWithoutManifest(env, workspace, host, "FOREIGN", "OTHER_FILE"), aggregate: "NOT_INSTALLED" };
  }
  const invalid = (reason: string, unknown: string[] = []): StateReport => ({
    ...empty, unknown, state: "INVALID", reason, rows: rowsWithoutManifest(env, workspace, host, "UNVERIFIABLE", "NO_MANIFEST"), aggregate: "UNVERIFIABLE_PREPARATION",
  });
  if (typeof dirStat === "string") return invalid(`the state directory cannot be read (${dirStat})`);
  if (!dirStat.isDirectory()) return invalid("the state path is not a directory");
  const unknown = unknownEntries(env, workspace);
  const manifestPath = env.path.join(workspace, ...MANIFEST.split("/"));
  const manifestStat = lstatOrCode(env, manifestPath);
  if (manifestStat === "ENOENT") return invalid("there is no manifest", unknown);
  if (typeof manifestStat === "string" || !manifestStat.isFile()) return invalid("the manifest is not a regular file", unknown);
  let manifestFile: FileRead;
  try {
    manifestFile = readBounded(env, manifestPath, MANIFEST_CAP, deadline, "the manifest");
  } catch (e) {
    if (e instanceof LeadError && e.code === "DEADLINE") throw e;
    return invalid(e instanceof LeadError ? e.message : `the manifest cannot be read (${errorCode(e)})`, unknown);
  }
  if (manifestFile.dev !== manifestStat.dev || manifestFile.ino !== manifestStat.ino) return invalid("the manifest changed while it was read", unknown);
  const checked = checkManifest(manifestFile.bytes, host, workspace);
  if (!checked.ok) return invalid(`the manifest is not valid: ${checked.reason}`, unknown);
  const manifest = checked.manifest;

  let tmp: StateReport["tmp"] = "ABSENT";
  const tmpPath = env.path.join(workspace, ...MANIFEST_TMP.split("/"));
  const tmpStat = lstatOrCode(env, tmpPath);
  if (tmpStat !== "ENOENT") {
    tmp = "DIFFERENT";
    if (typeof tmpStat !== "string" && tmpStat.isFile() && tmpStat.dev === manifestFile.dev && tmpStat.ino === manifestFile.ino) {
      try {
        const tmpFile = readBounded(env, tmpPath, MANIFEST_CAP, deadline);
        if (tmpFile.dev === manifestFile.dev && tmpFile.ino === manifestFile.ino && tmpFile.bytes.equals(manifestFile.bytes)) tmp = "SAME_AS_MANIFEST";
      } catch (e) {
        if (e instanceof LeadError && e.code === "DEADLINE") throw e;
      }
    }
  }

  // The two records name this manifest by hash; any other bytes are not a record of this install.
  const manifestSha = sha256(manifestFile.bytes);
  const directories: StateReport["directories"] = { state: "ABSENT", created: [], file: null };
  const directoriesFile = readRecord(env, env.path.join(workspace, ...DIRECTORIES.split("/")), deadline);
  if (directoriesFile !== "ABSENT") {
    const created = directoriesFile === "INVALID" ? null : checkDirectories(directoriesFile.bytes, host, manifestSha);
    if (directoriesFile === "INVALID" || created === null) directories.state = "INVALID";
    else Object.assign(directories, { state: "VALID", created, file: directoriesFile });
  }
  const complete: StateReport["complete"] = { state: "ABSENT", file: null };
  const completeFile = readRecord(env, env.path.join(workspace, ...COMPLETE.split("/")), deadline);
  if (completeFile !== "ABSENT") {
    if (completeFile === "INVALID" || !completeFile.bytes.equals(serializeComplete(manifestSha))) complete.state = "INVALID";
    else Object.assign(complete, { state: "VALID", file: completeFile });
  }

  const rows = manifest.rows.map((row) => classifyRow(env, workspace, row, deadline));
  // Only an install that is not recorded as finished can still have a running installer.
  const finished = complete.state === "VALID";
  const live = finished || (self && manifest.pid === env.pid) ? null : liveness(env, manifest.pid);
  const allThere = rows.every((r) => r.state === "OWNED_MATCH" && r.anchorState === "OK") && tmp === "ABSENT" && unknown.length === 0
    && directories.state === "VALID" && finished;
  const aggregate: Aggregate = allThere ? "INSTALLED" : live !== null && live !== "DEAD" ? "BUSY" : "PARTIAL";
  return { state: "VALID", reason: "", manifest, manifestFile, rows, tmp, unknown, directories, complete, liveness: live, aggregate };
}
