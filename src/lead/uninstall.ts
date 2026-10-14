// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Remove what `orch lead install` created and that is still exactly as it created it.
 *
 * A payload file is removed only when a valid manifest lists it, no folder on its path is a
 * link, it is the same file as its anchor (device and inode), and its bytes still have the
 * reviewed hash; this is checked again right before the unlink. Everything else stays and is
 * listed.
 *
 * A host-side directory is removed only when every payload path is gone, the directories record
 * of this install lists it, it is still that directory (device and inode), and it is empty: the
 * removal is a plain rmdir, deepest first, which the system refuses for a directory that holds
 * anything. A directory that was there before install, one without a record, one that was
 * replaced and one that holds a file of the user's stay and are listed with the reason.
 * Nothing is deleted recursively.
 *
 * The recorded installer process id is asked about only while the install is not recorded as
 * finished. Then a live, unaskable or unknown answer means BUSY and nothing is removed; "no
 * such process" lets uninstall remove what the records list.
 *
 * Limits: there is no way to tell the system "unlink only if this is still that file", so a
 * program that replaces a file or a folder between the last check and the removal is not
 * defended against. Two uninstalls at the same time are not supported. For an unfinished
 * install the question about the process id is a question, not a lock: a reused id makes
 * uninstall refuse (BUSY).
 */
import { BIG, errorCode, FILE_CAP, type FileRead, type LeadEnv, LeadError, MANIFEST_CAP, readBounded, sha256 } from "./pack.js";
import { COMPLETE, DIRECTORIES, type Host, hostDirs, insideWorkspace, MANIFEST, MANIFEST_TMP, OBJECTS_DIR, payloadRows, publicationOrder, STATE_DIR } from "./paths.js";
import { type Aggregate, classifyRow, type ManifestRow, readState, type RowState, type RowWhy, type StateReport } from "./status.js";

/** Why a host-side directory was left in place. */
export type DirWhy = "NOT_EMPTY" | "EXISTED" | "NO_RECORD" | "NOT_SAME" | "NOT_DIRECTORY" | "KEPT";

export interface Preserved {
  path: string;
  state: RowState | "STATE";
  why: RowWhy | "CHANGED" | "UNKNOWN_ENTRY" | "NOT_EMPTY" | "NEEDED";
}

export interface UninstallOutcome {
  aggregate: Aggregate;
  /** The state before anything was removed. */
  before: StateReport;
  removed: string[];
  absent: string[];
  preserved: Preserved[];
  stateRemoved: string[];
  /** Host-side directories this install created and uninstall removed, deepest first. */
  directoriesRemoved: string[];
  /** Host-side directories that exist and were left in place, with the reason. */
  directoriesLeft: { path: string; why: DirWhy }[];
}

function isAbsent(env: LeadEnv, path: string): boolean {
  try {
    env.fs.lstatSync(path, BIG);
    return false;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return true;
    throw e;
  }
}

/** Unlink `path` only if it is still the regular file with this identity. */
function unlinkSame(env: LeadEnv, path: string, id: { dev: bigint; ino: bigint }): "REMOVED" | "ABSENT" | "CHANGED" {
  let st;
  try {
    st = env.fs.lstatSync(path, BIG);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return "ABSENT";
    throw e;
  }
  if (!st.isFile() || st.dev !== id.dev || st.ino !== id.ino) return "CHANGED";
  try {
    env.fs.unlinkSync(path);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return "ABSENT";
    throw e;
  }
  return "REMOVED";
}

/** True when a record read again later is the same file with the same bytes as before. */
function sameRecord(before: FileRead, after: FileRead | null): boolean {
  return after !== null && after.dev === before.dev && after.ino === before.ino && after.bytes.equals(before.bytes);
}

export function uninstall(env: LeadEnv, workspace: string, host: Host, deadline: number): UninstallOutcome {
  const at = (rel: string) => insideWorkspace(env.path, workspace, rel);
  const before = readState(env, workspace, host, deadline);
  const outcome: UninstallOutcome = { aggregate: before.aggregate, before, removed: [], absent: [], preserved: [], stateRemoved: [], directoriesRemoved: [], directoriesLeft: [] };
  /**
   * The host-side directories, deepest first. With `remove`, a directory goes when the record
   * lists it, it is still that directory and rmdir finds it empty. Nothing below a path that is
   * not a real directory is looked at.
   */
  const directories = (remove: boolean) => {
    const recorded = new Map(before.directories.created.map((d) => [d.path, d]));
    const found = new Map<string, { dev: string; ino: string } | "ABSENT" | "NOT_DIRECTORY" | "BELOW">();
    for (const rel of hostDirs(host)) {
      const parent = found.get(rel.slice(0, Math.max(rel.lastIndexOf("/"), 0)));
      if (typeof parent === "string") {
        found.set(rel, parent === "ABSENT" ? "ABSENT" : "BELOW");
        continue;
      }
      try {
        const st = env.fs.lstatSync(at(rel), BIG);
        found.set(rel, st.isDirectory() ? { dev: String(st.dev), ino: String(st.ino) } : "NOT_DIRECTORY");
      } catch (e) {
        if (errorCode(e) !== "ENOENT") throw e;
        found.set(rel, "ABSENT");
      }
    }
    for (const rel of hostDirs(host).reverse()) {
      const now = found.get(rel)!;
      if (now === "ABSENT" || now === "BELOW") continue;
      const leave = (why: DirWhy) => void outcome.directoriesLeft.push({ path: rel, why });
      const row = recorded.get(rel);
      if (now === "NOT_DIRECTORY") leave("NOT_DIRECTORY");
      else if (before.directories.state !== "VALID") leave("NO_RECORD");
      else if (!row) leave("EXISTED");
      else if (!remove) leave("KEPT");
      else if (row.dev !== now.dev || row.ino !== now.ino) leave("NOT_SAME");
      else {
        try {
          env.fs.rmdirSync(at(rel));
          outcome.directoriesRemoved.push(rel);
        } catch (e) {
          if (errorCode(e) === "ENOENT") continue;
          if (!["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(errorCode(e))) throw e;
          leave(errorCode(e) === "ENOTDIR" ? "NOT_DIRECTORY" : "NOT_EMPTY");
        }
      }
    }
  };
  if (before.state === "ABSENT") {
    directories(false);
    return outcome;
  }
  // No valid manifest: nothing gives permission to delete, whatever the file names suggest.
  if (before.state === "INVALID" || !before.manifest || !before.manifestFile) return outcome;
  // An install that is not recorded as finished may still have a running installer. Alive, not
  // permitted to ask, or unknown: do nothing. A finished install was not asked about (null).
  if (before.liveness !== null && before.liveness !== "DEAD") {
    outcome.aggregate = "BUSY";
    return outcome;
  }

  // Payload files, the bootstrap file first so the host stops being pointed at a partial pack.
  const rows: ManifestRow[] = before.manifest.rows;
  const resolved = new Set<string>();
  for (const item of publicationOrder(payloadRows(host)).reverse()) {
    const row = rows.find((r) => r.path === item.dest);
    if (!row) throw new LeadError(`the manifest has no row for ${item.dest}`, "io", "MANIFEST");
    const now = classifyRow(env, workspace, row, deadline);
    if (now.state === "MISSING") {
      outcome.absent.push(row.path);
      resolved.add(row.path);
      continue;
    }
    if (now.state !== "OWNED_MATCH" || !now.id) {
      outcome.preserved.push({ path: row.path, state: now.state, why: now.why });
      continue;
    }
    const result = unlinkSame(env, at(row.path), now.id);
    if (result === "CHANGED") {
      outcome.preserved.push({ path: row.path, state: "UNVERIFIABLE", why: "UNSTABLE" });
    } else {
      (result === "REMOVED" ? outcome.removed : outcome.absent).push(row.path);
      resolved.add(row.path);
    }
  }

  // Host-side directories: only once every payload path is gone.
  const allAbsent = rows.every((r) => resolved.has(r.path));
  directories(allAbsent);

  // Anchors: only for rows whose payload path is now absent, and only with the full reviewed bytes.
  // When the anchors' folder is no longer a real directory, nothing in it is looked at; it is
  // listed below as an entry this version does not know.
  let stateClean = true;
  let anchorsReachable = true;
  try {
    anchorsReachable = env.fs.lstatSync(at(OBJECTS_DIR), BIG).isDirectory();
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
  for (const row of anchorsReachable ? rows : []) {
    const rel = `${STATE_DIR}/${row.anchor}`;
    const path = at(rel);
    if (isAbsent(env, path)) continue;
    if (!resolved.has(row.path)) {
      outcome.preserved.push({ path: rel, state: "STATE", why: "NEEDED" });
      stateClean = false;
      continue;
    }
    let removed = false;
    try {
      const st = env.fs.lstatSync(path, BIG);
      if (st.isFile()) {
        const file = readBounded(env, path, FILE_CAP, deadline);
        if (file.dev === st.dev && file.ino === st.ino && sha256(file.bytes) === row.sha256) removed = unlinkSame(env, path, file) !== "CHANGED";
      }
    } catch (e) {
      if (e instanceof LeadError && e.code === "DEADLINE") throw e;
      if (!(e instanceof LeadError) && errorCode(e) === "ERROR") throw e;
    }
    if (removed) {
      outcome.stateRemoved.push(rel);
    } else {
      outcome.preserved.push({ path: rel, state: "STATE", why: "CHANGED" });
      stateClean = false;
    }
  }

  // A leftover temporary manifest goes only when it is the manifest itself under a second name.
  const tmpPath = at(MANIFEST_TMP);
  if (!isAbsent(env, tmpPath)) {
    let removed = false;
    try {
      const st = env.fs.lstatSync(tmpPath, BIG);
      if (st.isFile() && st.dev === before.manifestFile.dev && st.ino === before.manifestFile.ino) {
        const file = readBounded(env, tmpPath, MANIFEST_CAP, deadline);
        if (file.dev === st.dev && file.ino === st.ino && file.bytes.equals(before.manifestFile.bytes)) removed = unlinkSame(env, tmpPath, file) !== "CHANGED";
      }
    } catch (e) {
      if (e instanceof LeadError && e.code === "DEADLINE") throw e;
      if (!(e instanceof LeadError) && errorCode(e) === "ERROR") throw e;
    }
    if (removed) {
      outcome.stateRemoved.push(MANIFEST_TMP);
    } else {
      outcome.preserved.push({ path: MANIFEST_TMP, state: "STATE", why: "CHANGED" });
      stateClean = false;
    }
  }

  // Entries this version does not know are never opened and never removed.
  const after = readState(env, workspace, host, deadline);
  for (const rel of after.unknown) {
    outcome.preserved.push({ path: rel, state: "STATE", why: "UNKNOWN_ENTRY" });
    stateClean = false;
  }

  // The two records: bytes that are not a record of this install are never removed.
  const records: [string, { state: string; file: FileRead | null }, { file: FileRead | null }][] = [
    [DIRECTORIES, before.directories, after.directories], [COMPLETE, before.complete, after.complete],
  ];
  for (const [rel, record] of records) {
    if (record.state !== "INVALID") continue;
    outcome.preserved.push({ path: rel, state: "STATE", why: "CHANGED" });
    stateClean = false;
  }

  // The records and the manifest go last, and only when every row is absent and the state holds
  // nothing else: first the directories record, then the record that install finished, then
  // the manifest.
  if (allAbsent && stateClean && after.state === "VALID" && after.manifestFile
    && after.manifestFile.dev === before.manifestFile.dev && after.manifestFile.ino === before.manifestFile.ino
    && after.manifestFile.bytes.equals(before.manifestFile.bytes)) {
    let recordsGone = true;
    for (const [rel, record, now] of records) {
      if (!recordsGone || record.state !== "VALID" || !record.file) continue;
      const result = sameRecord(record.file, now.file) ? unlinkSame(env, at(rel), record.file) : "CHANGED";
      if (result === "REMOVED") outcome.stateRemoved.push(rel);
      if (result === "CHANGED") {
        outcome.preserved.push({ path: rel, state: "STATE", why: "CHANGED" });
        recordsGone = false;
      }
    }
    if (!recordsGone) {
      outcome.preserved.push({ path: MANIFEST, state: "STATE", why: "NEEDED" });
    } else if (unlinkSame(env, at(MANIFEST), before.manifestFile) !== "CHANGED") {
      outcome.stateRemoved.push(MANIFEST);
      // Only the two reserved directories, only when empty; rmdir refuses anything else.
      let empty = true;
      for (const rel of [OBJECTS_DIR, STATE_DIR]) {
        if (!empty || isAbsent(env, at(rel))) continue;
        try {
          env.fs.rmdirSync(at(rel));
          outcome.stateRemoved.push(rel);
        } catch (e) {
          if (!["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(errorCode(e))) throw e;
          outcome.preserved.push({ path: rel, state: "STATE", why: "NOT_EMPTY" });
          empty = false;
        }
      }
      outcome.aggregate = empty ? "NOT_INSTALLED" : "UNVERIFIABLE_PREPARATION";
    } else {
      outcome.preserved.push({ path: MANIFEST, state: "STATE", why: "CHANGED" });
    }
  } else {
    outcome.preserved.push({ path: MANIFEST, state: "STATE", why: "NEEDED" });
  }
  if (outcome.aggregate !== "NOT_INSTALLED" && outcome.aggregate !== "UNVERIFIABLE_PREPARATION") outcome.aggregate = "PARTIAL";
  return outcome;
}
