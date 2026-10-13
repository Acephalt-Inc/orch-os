// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Remove what `orch lead install` created and that is still exactly as it created it.
 *
 * A payload file is removed only when a valid manifest lists it, it is the same file as its
 * anchor (device and inode), and its bytes still have the reviewed hash; this is checked again
 * right before the unlink. Everything else stays and is listed. Directories on the host side
 * are never removed. Nothing is deleted recursively.
 *
 * Limits: there is no way to tell the system "unlink only if this is still that file", so a
 * program that replaces a file between the last check and the unlink is not defended against.
 * Two uninstalls at the same time are not supported. The check on the recorded installer
 * process id is a question, not a lock: a reused id makes uninstall refuse (BUSY).
 */
import { BIG, errorCode, FILE_CAP, type LeadEnv, LeadError, MANIFEST_CAP, readBounded, sha256 } from "./pack.js";
import { type Host, insideWorkspace, MANIFEST, MANIFEST_TMP, OBJECTS_DIR, packDirs, payloadRows, publicationOrder, sharedParents, STATE_DIR } from "./paths.js";
import { type Aggregate, classifyRow, type ManifestRow, readState, type RowState, type RowWhy, type StateReport } from "./status.js";

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
  /** Host-side directories that exist and were left in place. */
  directoriesLeft: string[];
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

export function uninstall(env: LeadEnv, workspace: string, host: Host, deadline: number): UninstallOutcome {
  const at = (rel: string) => insideWorkspace(env.path, workspace, rel);
  const before = readState(env, workspace, host, deadline);
  const outcome: UninstallOutcome = { aggregate: before.aggregate, before, removed: [], absent: [], preserved: [], stateRemoved: [], directoriesLeft: [] };
  const listDirectories = () => {
    for (const rel of [...sharedParents(host), ...packDirs(host)]) if (!isAbsent(env, at(rel))) outcome.directoriesLeft.push(rel);
  };
  if (before.state === "ABSENT") {
    listDirectories();
    return outcome;
  }
  // No valid manifest: nothing gives permission to delete, whatever the file names suggest.
  if (before.state === "INVALID" || !before.manifest || !before.manifestFile) return outcome;
  // The installer may still be running. Alive, not permitted to ask, or unknown: do nothing.
  if (before.liveness !== "DEAD") {
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

  // Anchors: only for rows whose payload path is now absent, and only with the full reviewed bytes.
  let stateClean = true;
  for (const row of rows) {
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

  // The manifest goes last, and only when every row is absent and the state holds nothing else.
  const allAbsent = rows.every((r) => resolved.has(r.path));
  if (allAbsent && stateClean && after.state === "VALID" && after.manifestFile
    && after.manifestFile.dev === before.manifestFile.dev && after.manifestFile.ino === before.manifestFile.ino
    && after.manifestFile.bytes.equals(before.manifestFile.bytes)) {
    if (unlinkSame(env, at(MANIFEST), before.manifestFile) !== "CHANGED") {
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
  listDirectories();
  return outcome;
}
