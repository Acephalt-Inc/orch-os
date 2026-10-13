// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Create-only installation of the lead pack.
 *
 * Order: check every path (no writes) -> the caller prints the plan -> reserve the state
 * directory -> manifest -> one private anchor file per payload -> host directories -> the record
 * of which of those directories this run created -> one hard link per payload, the bootstrap
 * file last -> the record that install finished. Nothing is ever overwritten, renamed over,
 * copied over or rolled back. A collision found by the first step stops with no write at all; a
 * collision or error after that stops where it is and leaves what was already created, to be
 * reported by `status` and removed by `uninstall`.
 *
 * Limits: the checks are path checks, so a program that swaps a parent directory afterwards is
 * not defended against; directory modes are subject to the umask and are not an access boundary
 * on Windows; fsync is not a promise about power loss; there is no copy fallback where hard
 * links are unavailable.
 */
import {
  BIG, createExclusive, errorCode, FILE_CAP, type LeadEnv, LeadError, MANIFEST_CAP, type PackEntry, readBounded, sha256,
} from "./pack.js";
import {
  codePointCompare, COMPLETE, DIRECTORIES, type Host, insideWorkspace, MANIFEST, MANIFEST_TMP, OBJECTS_DIR, packDirs, payloadRows, publicationOrder, sharedParents,
  STATE_DIR,
} from "./paths.js";
import { checkManifest, type DirRow, readState, serializeComplete, serializeDirectories, serializeManifest, type StateReport } from "./status.js";

export type PlanKind = "directory" | "file" | "state" | "temporary";

export interface PlanLine {
  kind: PlanKind;
  /** Absolute path in the form this system writes. */
  path: string;
}

export interface Conflict {
  path: string;
  /** EXISTS, NOT_A_DIRECTORY or the system's error code. */
  why: string;
}

export interface Preflight {
  conflicts: Conflict[];
  /** Every path install would create, in code-point order. */
  lines: PlanLine[];
  /** Shared parent directories that are absent now and would be created. */
  missingParents: string[];
}

/** Resolve a workspace argument to its real directory. Throws a usage error on anything else. */
export function resolveWorkspace(env: LeadEnv, input: string, refuse: (input: string) => string | null): string {
  const reason = refuse(input);
  if (reason) throw new LeadError(`unsupported workspace path: ${reason}`, "usage");
  const absolute = env.path.resolve(input);
  if (env.path.parse(absolute).root === absolute) throw new LeadError("unsupported workspace path: the workspace cannot be the root of a drive or file system", "usage");
  let st;
  try {
    st = env.fs.lstatSync(absolute, BIG);
  } catch (e) {
    throw new LeadError(errorCode(e) === "ENOENT" ? `the workspace does not exist: ${absolute}` : `the workspace cannot be read (${errorCode(e)}): ${absolute}`, "usage");
  }
  if (st.isSymbolicLink()) throw new LeadError(`the workspace path is a link; give the folder it points to: ${absolute}`, "usage");
  if (!st.isDirectory()) throw new LeadError(`the workspace is not a folder: ${absolute}`, "usage");
  const real = env.fs.realpathSync.native(absolute);
  const again = refuse(real);
  if (again) throw new LeadError(`unsupported workspace path: ${again}`, "usage");
  const realStat = env.fs.lstatSync(real, BIG);
  if (!realStat.isDirectory() || realStat.dev !== st.dev || realStat.ino !== st.ino) throw new LeadError(`the workspace changed while it was checked: ${absolute}`, "usage");
  return real;
}

/**
 * Look at every path install would create. Only "no such file" counts as absent: a file, a
 * directory, a link (also a dangling one) or an unreadable entry is a conflict. Reads only.
 */
export function preflight(env: LeadEnv, workspace: string, host: Host): Preflight {
  const at = (rel: string) => insideWorkspace(env.path, workspace, rel);
  const conflicts = new Map<string, Conflict>();
  const lines: PlanLine[] = [];
  const missingParents: string[] = [];
  const mustBeAbsent = (rel: string, kind: PlanKind) => {
    const path = at(rel);
    lines.push({ kind, path });
    try {
      env.fs.lstatSync(path, BIG);
      conflicts.set(path, { path, why: "EXISTS" });
    } catch (e) {
      if (errorCode(e) !== "ENOENT") conflicts.set(path, { path, why: errorCode(e) });
    }
  };
  mustBeAbsent(STATE_DIR, "directory");
  mustBeAbsent(OBJECTS_DIR, "directory");
  mustBeAbsent(MANIFEST, "state");
  mustBeAbsent(MANIFEST_TMP, "temporary");
  mustBeAbsent(DIRECTORIES, "state");
  mustBeAbsent(COMPLETE, "state");
  for (const rel of sharedParents(host)) {
    const path = at(rel);
    try {
      const st = env.fs.lstatSync(path, BIG);
      if (!st.isDirectory()) conflicts.set(path, { path, why: "NOT_A_DIRECTORY" });
    } catch (e) {
      if (errorCode(e) === "ENOENT") {
        missingParents.push(rel);
        lines.push({ kind: "directory", path });
      } else {
        conflicts.set(path, { path, why: errorCode(e) });
      }
    }
  }
  for (const rel of packDirs(host)) mustBeAbsent(rel, "directory");
  for (const row of payloadRows(host)) {
    mustBeAbsent(row.dest, "file");
    mustBeAbsent(`${STATE_DIR}/${row.anchor}`, "state");
  }
  lines.sort((a, b) => codePointCompare(a.path, b.path));
  return { conflicts: [...conflicts.values()].sort((a, b) => codePointCompare(a.path, b.path)), lines, missingParents };
}

export interface InstallOutcome {
  /** RESERVED_BY_OTHER: the state directory appeared after the check; this run created nothing. */
  stop: "NONE" | "RESERVED_BY_OTHER" | "COLLISION" | "ERROR";
  /** Path of the collision or failing step, when stopped. */
  stoppedAt: string;
  /** Error code or message of the stop. */
  detail: string;
  published: number;
  /** State read back from disk after the run; null when this run created nothing. */
  report: StateReport | null;
}

/** Create one directory (never an existing one) and return its identity. */
function makeDirectory(env: LeadEnv, path: string, mode: number): { dev: string; ino: string } {
  env.fs.mkdirSync(path, { mode, recursive: false });
  const st = env.fs.lstatSync(path, BIG);
  if (!st.isDirectory()) throw new LeadError(`${path} is not a directory after it was created`, "io", "NOT_A_DIRECTORY");
  return { dev: String(st.dev), ino: String(st.ino) };
}

/**
 * Create the installation. Call only after `preflight` found no conflict and the plan was
 * printed. Stops at the first collision or error and never undoes or overwrites anything.
 */
export function install(env: LeadEnv, workspace: string, host: Host, pack: readonly PackEntry[], missingParents: readonly string[], deadline: number): InstallOutcome {
  const at = (rel: string) => insideWorkspace(env.path, workspace, rel);
  let published = 0;
  let step = at(STATE_DIR);
  try {
    env.fs.mkdirSync(step, { mode: 0o700, recursive: false });
  } catch (e) {
    if (errorCode(e) === "EEXIST") return { stop: "RESERVED_BY_OTHER", stoppedAt: step, detail: "EEXIST", published, report: null };
    throw e;
  }
  const stopped = (stop: "COLLISION" | "ERROR", detail: string): InstallOutcome =>
    ({ stop, stoppedAt: step, detail, published, report: readState(env, workspace, host, deadline, true) });
  try {
    if (!env.fs.lstatSync(step, BIG).isDirectory()) throw new LeadError(`${step} is not a directory`, "io", "NOT_A_DIRECTORY");
    step = at(OBJECTS_DIR);
    makeDirectory(env, step, 0o700);

    // The manifest: complete in a temporary name first, then given its real name with a hard
    // link (which never replaces a file), then the temporary name is removed.
    const manifestBytes = serializeManifest(host, workspace, env.pid);
    const manifestPath = at(MANIFEST);
    step = at(MANIFEST_TMP);
    createExclusive(env, step, manifestBytes, 0o600, deadline, false);
    env.fs.linkSync(step, manifestPath);
    env.fs.unlinkSync(step);
    step = manifestPath;
    const onDisk = readBounded(env, manifestPath, MANIFEST_CAP, deadline, "the manifest");
    const checked = checkManifest(onDisk.bytes, host, workspace);
    if (!checked.ok || !onDisk.bytes.equals(manifestBytes)) throw new LeadError("the manifest on disk is not the one just written", "io", "MANIFEST");

    // One anchor per payload: the packaged bytes in a new private file, read back before use.
    for (const entry of pack) {
      step = at(`${STATE_DIR}/${entry.anchor}`);
      createExclusive(env, step, entry.bytes, 0o600, deadline, true);
    }

    // Host directories. The two shared parents may have appeared meanwhile and must then be
    // real directories; the pack's own directories must be new. Only a directory this run's own
    // mkdir created is remembered: one that appeared meanwhile belongs to whoever made it.
    const manifestSha = sha256(manifestBytes);
    const created: DirRow[] = [];
    let failure: { error: unknown } | null = null;
    try {
      for (const rel of missingParents) {
        step = at(rel);
        try {
          created.push({ path: rel, ...makeDirectory(env, step, 0o777) });
        } catch (e) {
          if (errorCode(e) !== "EEXIST" || !env.fs.lstatSync(step, BIG).isDirectory()) throw e;
        }
      }
      for (const rel of packDirs(host)) {
        step = at(rel);
        created.push({ path: rel, ...makeDirectory(env, step, 0o777) });
      }
    } catch (e) {
      failure = { error: e };
    }
    // The record of the directories this run created, with their identity. It is written also
    // when a directory step failed, so that uninstall can remove exactly what was created.
    const failedAt = step;
    try {
      step = at(DIRECTORIES);
      createExclusive(env, step, serializeDirectories(manifestSha, created), 0o600, deadline, true);
    } catch (e) {
      if (failure === null) throw e;
    }
    if (failure !== null) {
      step = failedAt;
      throw failure.error;
    }

    // Publication: each payload path becomes a second name of its anchor. linkSync fails with
    // EEXIST when the path exists, so a file that appeared meanwhile is never touched.
    for (const entry of publicationOrder(pack)) {
      step = at(entry.dest);
      const parent = env.fs.lstatSync(env.path.dirname(step), BIG);
      if (!parent.isDirectory()) throw new LeadError(`${env.path.dirname(step)} is not a directory`, "io", "NOT_A_DIRECTORY");
      const anchorPath = at(`${STATE_DIR}/${entry.anchor}`);
      const anchor = readBounded(env, anchorPath, FILE_CAP, deadline);
      if (sha256(anchor.bytes) !== entry.sha256) throw new LeadError(`${anchorPath} does not hold the reviewed text`, "io", "ANCHOR");
      env.fs.linkSync(anchorPath, step);
      published += 1;
    }

    // Last: the record that install finished. Until it exists, status and uninstall ask
    // whether the recorded installer process is still running.
    step = at(COMPLETE);
    createExclusive(env, step, serializeComplete(manifestSha), 0o600, deadline, true);
  } catch (e) {
    if (e instanceof LeadError && e.code === "DEADLINE") throw e;
    if (errorCode(e) === "EEXIST") return stopped("COLLISION", "EEXIST");
    if (!(e instanceof LeadError) && errorCode(e) === "ERROR") throw e;
    return stopped("ERROR", e instanceof LeadError ? e.message : errorCode(e));
  }
  return { stop: "NONE", stoppedAt: "", detail: "", published, report: readState(env, workspace, host, deadline, true) };
}
