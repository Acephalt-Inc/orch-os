// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// `orch lead status` and `orch lead uninstall` against states built by hand: a manifest is a
// record of intent and never of completion, and uninstall removes a file only when it is the
// file install created (same inode as its anchor) with unchanged content.
// Every command here is the compiled CLI (dist/cli.js, built by `npm test`) run as a process.
//
// Measured on macOS. Skipped on Windows unless ORCH_LEAD_UNMEASURED=1: not native Windows proof.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DIST_CLI, ROOT, WINDOWS } from "./_helpers.js";

const RUN = !WINDOWS || process.env.ORCH_LEAD_UNMEASURED === "1";
const FROZEN = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "lead-reviewed-text.json"), "utf8"));
type Host = "claude" | "codex";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const dests = (host: Host): string[] => FROZEN.inventory[host].map((row: string[]) => row[1]);
const sourceOf = (host: Host, dest: string): string => FROZEN.inventory[host].find((row: string[]) => row[1] === dest)[0];
const reviewedBytes = (host: Host, dest: string) => readFileSync(join(ROOT, ...sourceOf(host, dest).split("/")));
const anchorOf = (host: Host, dest: string) => `.orch-lead-install/objects/${String(dests(host).indexOf(dest)).padStart(2, "0")}`;
const H = ".claude/skills/orch-lead";
const at = (workspace: string, rel: string) => join(workspace, ...rel.split("/"));
const ACTIVATION = "host activation: unverified";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): { base: string; w: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "orch-lead-i-")));
  scratch.push(base);
  const w = join(base, "work space");
  mkdirSync(w);
  return { base, w };
}
function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out.push(`link ${r} -> ${readlinkSync(join(dir, r))}`);
    else if (st.isDirectory()) out.push(`dir ${r}`, ...tree(dir, r));
    else if (st.isFile()) out.push(`file ${r} ${sha(readFileSync(join(dir, r)))}`);
    else out.push(`other ${r}`);
  }
  return out;
}
/** Device, inode and kind of a path, or "absent". */
function idOf(path: string): string {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.dev}:${st.ino}:${st.isFile() ? "file" : st.isSymbolicLink() ? "link" : st.isFIFO() ? "fifo" : "other"}`;
  } catch {
    return "absent";
  }
}
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "orch-lead-i-env-")));
scratch.push(home);
/** Run the compiled CLI as a process, with a home and an ORCH home that do not exist. */
function lead(...args: string[]) {
  const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...args], {
    encoding: "utf8", timeout: 20_000, cwd: home,
    env: { PATH: process.env.PATH, HOME: join(home, "home"), USERPROFILE: join(home, "home"), ORCH_HOME: join(home, "orch-home"), SystemRoot: process.env.SystemRoot },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", pid: r.pid };
}
function rowStates(stdout: string, w: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^ {2}(OWNED_MATCH|OWNED_CHANGED|MISSING|FOREIGN|UNVERIFIABLE)\s+(.+?)(?: {2}\(.*\))?$/.exec(line);
    if (m && m[2].startsWith(w + sep)) out[m[2].slice(w.length + 1).split(sep).join("/")] = m[1];
  }
  return out;
}
const resultOf = (stdout: string) => /^result: (\w+)$/m.exec(stdout)?.[1] ?? "";
const lastLine = (stdout: string) => stdout.trimEnd().split("\n").pop();
/** The manifest text, written here independently of the implementation. */
function manifestText(host: Host, w: string, pid: number): string {
  return `{"schema":1,"host":"${host}","workspace":${JSON.stringify(w)},"pack":"${FROZEN.pack_hash[host]}","pid":${pid},"rows":[\n`
    + dests(host).map((dest, i) => `    {"path":"${dest}","sha256":"${FROZEN.sources[sourceOf(host, dest)]}","anchor":"objects/${String(i).padStart(2, "0")}"}`).join(",\n") + "\n]}\n";
}
/** The id of a process that has already ended. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 }).pid;
/** A step of the user's own that may find nothing to act on when a command under test misbehaved; the assertions report that. */
const attempt = (step: () => void) => {
  try {
    step();
  } catch { /* the assertions after this step show the difference */ }
};
const all = (host: Host, state: string) => Object.fromEntries(dests(host).map((dest) => [dest, state]));

describe.skipIf(!RUN)("orch lead: state on disk decides", () => {
  it("lead_manifest_intent_is_not_completion", () => {
    const args = (w: string) => ["--workspace", w, "--host", "claude"];
    const statuses: string[] = [];
    const status = (w: string) => {
      const r = lead("status", ...args(w));
      statuses.push(r.out);
      return r;
    };
    // No state directory at all.
    {
      const { w } = workspace();
      const r = status(w);
      expect.soft([r.code, resultOf(r.out), rowStates(r.out, w)], `[result-table] an empty workspace is NOT_INSTALLED\n${r.out}${r.err}`).toEqual([0, "NOT_INSTALLED", all("claude", "MISSING")]);
    }
    // A valid manifest and nothing else: intent only.
    {
      const { w } = workspace();
      mkdirSync(at(w, ".orch-lead-install/objects"), { recursive: true });
      writeFileSync(at(w, ".orch-lead-install/manifest.json"), manifestText("claude", w, deadPid()));
      const r = status(w);
      expect.soft([r.code, resultOf(r.out), rowStates(r.out, w)], `[intent-not-completion] a manifest without anchors or files is PARTIAL, all rows MISSING\n${r.out}${r.err}`)
        .toEqual([2, "PARTIAL", all("claude", "MISSING")]);
      expect.soft(r.out, "[intent-not-completion] 0 complete anchors are reported").toContain("anchors complete: 0 of 17");
    }
    // Manifest and every anchor complete, but no file was published.
    {
      const { w } = workspace();
      mkdirSync(at(w, ".orch-lead-install/objects"), { recursive: true });
      writeFileSync(at(w, ".orch-lead-install/manifest.json"), manifestText("claude", w, deadPid()));
      for (const dest of dests("claude")) writeFileSync(at(w, anchorOf("claude", dest)), reviewedBytes("claude", dest));
      const r = status(w);
      expect.soft([r.code, resultOf(r.out), rowStates(r.out, w)], `[intent-not-completion] complete anchors without published files are PARTIAL\n${r.out}`).toEqual([2, "PARTIAL", all("claude", "MISSING")]);
    }
    // Manifest, half-written anchors, and files with the right text that install did not create.
    {
      const { w } = workspace();
      mkdirSync(at(w, ".orch-lead-install/objects"), { recursive: true });
      mkdirSync(at(w, `${H}/agents`), { recursive: true });
      mkdirSync(at(w, `${H}/workflows`));
      writeFileSync(at(w, ".orch-lead-install/manifest.json"), manifestText("claude", w, deadPid()));
      for (const dest of dests("claude")) {
        const bytes = reviewedBytes("claude", dest);
        writeFileSync(at(w, anchorOf("claude", dest)), bytes.subarray(0, Math.floor(bytes.length / 2)));
        writeFileSync(at(w, dest), bytes);
      }
      const r = status(w);
      expect.soft([r.code, resultOf(r.out), rowStates(r.out, w)], `[intent-not-completion] right text at every path, none of it owned: PARTIAL, all rows FOREIGN\n${r.out}`)
        .toEqual([2, "PARTIAL", all("claude", "FOREIGN")]);
    }
    // A manifest that says it is complete is not a manifest this version accepts.
    {
      const { w } = workspace();
      mkdirSync(at(w, ".orch-lead-install/objects"), { recursive: true });
      writeFileSync(at(w, ".orch-lead-install/manifest.json"), manifestText("claude", w, deadPid()).replace('"schema":1', '"schema":1,"complete":true'));
      const r = status(w);
      expect.soft([r.code, resultOf(r.out)], `[intent-not-completion] a completion flag does not override the disk\n${r.out}`).toEqual([2, "UNVERIFIABLE_PREPARATION"]);
    }
    // A real install is INSTALLED; one unexpected entry in the state directory and it is not.
    {
      const { base, w } = workspace();
      expect(lead("install", ...args(w)).code, "install").toBe(0);
      const installed = status(w);
      expect.soft([installed.code, resultOf(installed.out), rowStates(installed.out, w)], `[result-table] a complete install is INSTALLED\n${installed.out}`).toEqual([0, "INSTALLED", all("claude", "OWNED_MATCH")]);
      writeFileSync(at(w, ".orch-lead-install/extra"), "x");
      const extra = status(w);
      expect.soft([extra.code, resultOf(extra.out)], `[result-table] an unexpected entry in the state directory means not INSTALLED\n${extra.out}`).toEqual([2, "PARTIAL"]);
      unlinkSync(at(w, ".orch-lead-install/extra"));
      expect.soft(resultOf(status(w).out), "[result-table] INSTALLED again without the entry").toBe("INSTALLED");
      // The workspace folder is renamed: the manifest names the old path.
      const moved = join(base, "moved");
      renameSync(w, moved);
      const before = tree(moved);
      const after = status(moved);
      expect.soft([after.code, resultOf(after.out)], `[moved-workspace] status after the folder was renamed\n${after.out}`).toEqual([2, "UNVERIFIABLE_PREPARATION"]);
      const un = lead("uninstall", ...args(moved));
      expect.soft([un.code, resultOf(un.out), tree(moved)], "[moved-workspace] uninstall then removes nothing").toEqual([2, "UNVERIFIABLE_PREPARATION", before]);
    }
    expect(statuses.length).toBe(9);
    expect.soft(statuses.map(lastLine), "[activation-unverified] every status ends with the activation line").toEqual(statuses.map(() => ACTIVATION));
    expect.soft(statuses.filter((out) => /all files were written|activation: verified/.test(out)), "[activation-unverified] no status claims more").toEqual([]);
  });

  it("lead_uninstall_requires_identity_and_hash", () => {
    const { w } = workspace();
    const args = ["--workspace", w, "--host", "claude"];
    expect(lead("install", ...args).code, "install").toBe(0);
    writeFileSync(join(w, "my-notes.md"), "the user's own notes\n");
    const p = (name: string) => `${H}/${name}`;
    // In-place edit: the same file, other content.
    appendFileSync(at(w, p("brief.md")), "my own line\n");
    // Editor-style replacement with the same text: another file under the same name.
    writeFileSync(at(w, p("handoff.md.new")), reviewedBytes("claude", p("handoff.md")));
    renameSync(at(w, p("handoff.md.new")), at(w, p("handoff.md")));
    // Replacement with other text.
    writeFileSync(at(w, p("routing.md.new")), "my routing\n");
    renameSync(at(w, p("routing.md.new")), at(w, p("routing.md")));
    // The anchor is gone: nothing proves ownership any more.
    unlinkSync(at(w, anchorOf("claude", p("agents/reader.md"))));
    // A special file and a link where installed files were.
    unlinkSync(at(w, p("agents/builder.md")));
    const fifo = spawnSync("mkfifo", [at(w, p("agents/builder.md"))], { timeout: 10_000 });
    expect(fifo.status, "mkfifo").toBe(0);
    unlinkSync(at(w, p("agents/advisor.md")));
    symlinkSync(join(w, "my-notes.md"), at(w, p("agents/advisor.md")));
    // And one file simply deleted.
    unlinkSync(at(w, p("workflows/memory.md")));

    const kept = [p("brief.md"), p("handoff.md"), p("routing.md"), p("agents/reader.md"), p("agents/builder.md"), p("agents/advisor.md")];
    const expected: Record<string, string> = {
      ...all("claude", "OWNED_MATCH"), [p("brief.md")]: "OWNED_CHANGED", [p("handoff.md")]: "FOREIGN", [p("routing.md")]: "FOREIGN",
      [p("agents/reader.md")]: "UNVERIFIABLE", [p("agents/builder.md")]: "FOREIGN", [p("agents/advisor.md")]: "FOREIGN", [p("workflows/memory.md")]: "MISSING",
    };
    const status = lead("status", ...args);
    expect.soft([status.code, resultOf(status.out)], `status\n${status.out}${status.err}`).toEqual([2, "PARTIAL"]);
    expect.soft(rowStates(status.out, w), "[state-table] status names the state of each of the 17 paths").toEqual(expected);

    const identity = () => Object.fromEntries(kept.map((rel) => [rel, idOf(at(w, rel))]));
    const content = () => [readFileSync(at(w, p("brief.md")), "utf8").endsWith("my own line\n"), sha(readFileSync(at(w, p("handoff.md")))), readFileSync(at(w, p("routing.md")), "utf8"),
      sha(readFileSync(at(w, p("agents/reader.md")))), readlinkSync(at(w, p("agents/advisor.md"))), readFileSync(join(w, "my-notes.md"), "utf8")];
    const [idsBefore, contentBefore] = [identity(), content()];
    const uninstall = lead("uninstall", ...args);
    expect.soft([uninstall.code, resultOf(uninstall.out)], `uninstall reports residue\n${uninstall.out}${uninstall.err}`).toEqual([2, "PARTIAL"]);
    expect.soft(identity(), "[identity-and-hash] every changed, replaced, unproven, special or linked path is still the same file").toEqual(idsBefore);
    let contentAfter: unknown[] = ["unreadable"];
    try {
      contentAfter = content();
    } catch { /* reported by the comparison below */ }
    expect.soft(contentAfter, "[identity-and-hash] and its content is unchanged").toEqual(contentBefore);
    const gone = dests("claude").filter((dest) => !kept.includes(dest));
    expect.soft(gone.filter((dest) => existsSync(at(w, dest))), "the unchanged installed files were removed").toEqual([]);
    for (const rel of kept) expect.soft(uninstall.out, `[identity-and-hash] ${rel} is listed as preserved`).toContain(`preserved       ${at(w, rel)}  (`);
    expect.soft([existsSync(at(w, ".orch-lead-install/manifest.json")), kept.filter((rel) => rel !== p("agents/reader.md")).filter((rel) => !existsSync(at(w, anchorOf("claude", rel))))],
      "[state-kept-with-residue] the manifest and the anchors of preserved paths stay").toEqual([true, []]);

    // The user moves the kept files away (the edited one by renaming it) and runs uninstall again.
    attempt(() => renameSync(at(w, p("brief.md")), join(w, "my-brief.md")));
    for (const rel of kept.slice(1)) attempt(() => unlinkSync(at(w, rel)));
    const second = lead("uninstall", ...args);
    const editedAnchor = at(w, anchorOf("claude", p("brief.md")));
    expect.soft([existsSync(editedAnchor) && readFileSync(editedAnchor, "utf8").endsWith("my own line\n"), existsSync(editedAnchor) && idOf(editedAnchor) === idOf(join(w, "my-brief.md"))],
      `[edited-anchor-kept] the anchor that is a second name of the edited file stays\n${second.out}`).toEqual([true, true]);
    expect.soft([second.code, resultOf(second.out), existsSync(at(w, ".orch-lead-install/manifest.json"))], "[edited-anchor-kept] and uninstall reports it").toEqual([2, "PARTIAL", true]);
    expect.soft(second.out, "[edited-anchor-kept] with its path").toContain(`state preserved ${editedAnchor}  (`);

    // A complete uninstall leaves the host directories, and those refuse a new install.
    const { w: clean } = workspace();
    const cleanArgs = ["--workspace", clean, "--host", "claude"];
    expect(lead("install", ...cleanArgs).code, "install").toBe(0);
    const done = lead("uninstall", ...cleanArgs);
    expect.soft([done.code, resultOf(done.out)], `complete uninstall\n${done.out}${done.err}`).toEqual([0, "NOT_INSTALLED"]);
    expect.soft(tree(clean), "[directories-left] uninstall removes no directory outside its state directory")
      .toEqual(["dir .claude", "dir .claude/skills", `dir ${H}`, `dir ${H}/agents`, `dir ${H}/workflows`]);
    const refused = lead("install", ...cleanArgs);
    expect.soft([refused.code, resultOf(refused.out)], "a new install is refused while the empty pack directory exists").toEqual([2, "CONFLICT"]);
    for (const rel of [`${H}/workflows`, `${H}/agents`, H]) {
      attempt(() => rmdirSync(at(clean, rel)));
    }
    expect.soft(lead("install", ...cleanArgs).code, "and accepted once the user deleted it").toBe(0);
  });
});
