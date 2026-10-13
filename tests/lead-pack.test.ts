// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The lead pack: one inventory of 20 files per host, shared by the plan install prints, the files
// it creates, the manifest it writes and the references inside the text; and file reads and
// writes that never let half a file reach a destination.
// The expected lists come from tests/fixtures/lead-reviewed-text.json, never from src/lead.
// The text checks read the installed files in the workspace, never the templates.
//
// Measured on macOS. Skipped on Windows unless ORCH_LEAD_UNMEASURED=1: not native Windows proof.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { DIST_CLI, ROOT, WINDOWS } from "./_helpers.js";

const RUN = !WINDOWS || process.env.ORCH_LEAD_UNMEASURED === "1";
const FROZEN = JSON.parse(fs.readFileSync(join(ROOT, "tests", "fixtures", "lead-reviewed-text.json"), "utf8"));
type Host = "claude" | "codex";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const dests = (host: Host): string[] => FROZEN.inventory[host].map((row: string[]) => row[1]);
const sourceOf = (host: Host, dest: string): string => FROZEN.inventory[host].find((row: string[]) => row[1] === dest)[0];
const hashOfDest = (host: Host, dest: string): string => FROZEN.sources[sourceOf(host, dest)];
const anchorOf = (host: Host, dest: string) => `.orch-lead-install/objects/${String(dests(host).indexOf(dest)).padStart(2, "0")}`;
const LAYOUT: Record<Host, { root: string; boot: string; parents: string[] }> = {
  claude: { root: ".claude/skills/orch-lead", boot: "CLAUDE.md", parents: [".claude", ".claude/skills"] },
  codex: { root: ".agents/skills/orch-lead", boot: "AGENTS.md", parents: [".agents", ".agents/skills"] },
};
const at = (workspace: string, rel: string) => join(workspace, ...rel.split("/"));

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function workspace(): { base: string; w: string } {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "orch-lead-k-")));
  scratch.push(base);
  const w = join(base, "work space");
  fs.mkdirSync(w);
  return { base, w };
}
/** Files below `dir` with their content hash, and directories. Sorted. */
function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(join(dir, r));
    if (st.isDirectory()) out.push(`dir ${r}`, ...tree(dir, r));
    else out.push(st.isFile() ? `file ${r} ${sha(fs.readFileSync(join(dir, r)))}` : `other ${r}`);
  }
  return out;
}
const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "orch-lead-k-env-")));
scratch.push(home);
function lead(...args: string[]) {
  const r = spawnSync(process.execPath, [DIST_CLI, "lead", ...args], {
    encoding: "utf8", timeout: 20_000, cwd: home,
    env: { PATH: process.env.PATH, HOME: join(home, "home"), USERPROFILE: join(home, "home"), ORCH_HOME: join(home, "orch-home"), SystemRoot: process.env.SystemRoot },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", pid: r.pid };
}
const resultOf = (stdout: string) => /^result: (\w+)$/m.exec(stdout)?.[1] ?? "";
const planned = (stdout: string, kind: string) => stdout.split("\n").map((line) => new RegExp(`^ {2}${kind}\\s+(.+)$`).exec(line)?.[1]).filter(Boolean);
function manifestText(host: Host, w: string, pid: number): string {
  return `{"schema":1,"host":"${host}","workspace":${JSON.stringify(w)},"pack":"${FROZEN.pack_hash[host]}","pid":${pid},"rows":[\n`
    + dests(host).map((dest, i) => `    {"path":"${dest}","sha256":"${hashOfDest(host, dest)}","anchor":"objects/${String(i).padStart(2, "0")}"}`).join(",\n") + "\n]}\n";
}
/** What one Markdown text names: link targets outside code, file names, folder names, and its code spans. */
function namesIn(text: string): { links: string[]; files: string[]; folders: string[]; spans: string[] } {
  const spans: string[] = [];
  const outside = text.replace(/```[\s\S]*?```/g, " ").replace(/`([^`\n]+)`/g, (_, inner: string) => (spans.push(inner), " "));
  const links = [...outside.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const rest = [outside.replace(/\[[^\]]*\]\([^)]*\)/g, " "), ...spans];
  const files = rest.flatMap((part) => [...part.matchAll(/(?<![\w./-])((?:[\w.-]+\/)*[\w-]+\.(?:md|csv))(?![\w/-])/g)].map((m) => m[1]));
  const folders = rest.flatMap((part) => [...part.matchAll(/(?<![\w.<-])\/?((?:[\w.-]+\/)+)(?![\w.<-])/g)].map((m) => m[1]));
  return { links, files: [...new Set(files)], folders: [...new Set(folders)], spans };
}
/** Names the guides use for the notes a user keeps. Install creates none of them. */
const NOTES_FILES = ["INDEX.md", "entries/name.md", "workspace-notes/personal/INDEX.md", "workspace-notes/shared/INDEX.md"];
const NOTES_FOLDERS = ["archive/", "files/", "workspace-notes/", "workspace-notes/personal/", "workspace-notes/shared/"];
/** Run the CLI in this process with replaced parts. */
async function inProcess(args: string[], deps: Record<string, unknown>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(["lead", ...args], { out: (s) => (out += s), err: (s) => (err += s), stdin: () => "" }, { lead: deps } as never);
  return { code, out, err };
}

describe.skipIf(!RUN)("orch lead: one inventory", () => {
  it("lead_shared_inventory_and_references", () => {
    expect([dests("claude").length, dests("codex").length, Object.keys(FROZEN.sources).length]).toEqual([20, 20, 21]);
    for (const host of ["claude", "codex"] as Host[]) {
      const { w } = workspace();
      const layout = LAYOUT[host];
      const args = ["--workspace", w, "--host", host];
      const stateFiles = [".orch-lead-install/manifest.json", ".orch-lead-install/directories.json", ".orch-lead-install/complete", ...dests(host).map((dest) => anchorOf(host, dest))];
      const directories = [...layout.parents, layout.root, `${layout.root}/agents`, `${layout.root}/workflows`, ".orch-lead-install", ".orch-lead-install/objects"];

      // What install says it will create.
      const dry = lead("install", ...args, "--dry-run");
      expect.soft([dry.code, planned(dry.out, "file")], `[inventory] ${host}: the 20 planned files\n${dry.err}`).toEqual([0, dests(host).map((dest) => at(w, dest)).sort()]);
      expect.soft(planned(dry.out, "state"), `[inventory] ${host}: the planned manifest, two records and 20 anchors`).toEqual(stateFiles.map((rel) => at(w, rel)).sort());
      expect.soft(planned(dry.out, "directory"), `[inventory] ${host}: the planned directories`).toEqual(directories.map((rel) => at(w, rel)).sort());
      expect.soft(planned(dry.out, "temporary"), `[inventory] ${host}: the planned temporary name`).toEqual([at(w, ".orch-lead-install/manifest.tmp")]);

      // What it creates.
      const install = lead("install", ...args);
      expect.soft([install.code, resultOf(install.out)], `[inventory] ${host}: install completes\n${install.out}${install.err}`).toEqual([0, "INSTALLED"]);
      const onDisk = tree(w);
      expect.soft(onDisk.filter((line) => line.startsWith("file ") && !line.includes(".orch-lead-install/")), `[inventory] ${host}: exactly the 20 files, each with its reviewed text`)
        .toEqual(dests(host).map((dest) => `file ${dest} ${hashOfDest(host, dest)}`).sort());
      expect.soft(onDisk.filter((line) => line.includes(" .orch-lead-install/")).map((line) => line.split(" ")[1]).sort(), `[inventory] ${host}: the state directory holds the manifest, the two records, objects and 20 anchors`)
        .toEqual([".orch-lead-install/objects", ...stateFiles].sort());
      expect.soft(onDisk.filter((line) => line.startsWith("dir ")).map((line) => line.slice(4)).sort(), `[inventory] ${host}: the directories`).toEqual([...directories].sort());
      expect.soft(onDisk.filter((line) => line.startsWith("other ")), `${host}: nothing else`).toEqual([]);
      let manifest = "absent";
      try {
        manifest = fs.readFileSync(at(w, ".orch-lead-install/manifest.json"), "utf8");
      } catch { /* compared below */ }
      expect.soft(manifest, `[manifest-text] ${host}: the manifest names host, workspace, pack, installer and 20 rows, and nothing else`).toBe(manifestText(host, w, install.pid));
      // The two records name that manifest by hash. The first lists the host directories install created, each with its identity.
      const record = (rel: string) => (fs.existsSync(at(w, rel)) ? fs.readFileSync(at(w, rel), "utf8") : "absent");
      const hostDirectories = directories.filter((rel) => !rel.startsWith(".orch-lead-install"));
      const identityOf = (rel: string) => {
        const st = fs.lstatSync(at(w, rel), { bigint: true, throwIfNoEntry: false });
        return `    {"path":"${rel}","dev":"${st?.dev ?? "absent"}","ino":"${st?.ino ?? "absent"}"}`;
      };
      expect.soft(record(".orch-lead-install/directories.json"), `[directories-record] ${host}: the record lists the 5 directories install created in a new workspace, outermost first, and nothing else`)
        .toBe(`{"schema":1,"manifest":"${sha(manifest)}","created":[\n${hostDirectories.map(identityOf).join(",\n")}\n]}\n`);
      expect.soft(record(".orch-lead-install/complete"), `[finished-record] ${host}: the record that install finished names the manifest`).toBe(`{"schema":1,"manifest":"${sha(manifest)}","install":"complete"}\n`);

      // Each installed file is its anchor under a second name, with the packaged bytes.
      const identity = dests(host).map((dest) => {
        try {
          const a = fs.lstatSync(at(w, dest), { bigint: true });
          const b = fs.lstatSync(at(w, anchorOf(host, dest)), { bigint: true });
          return [dest, a.dev === b.dev && a.ino === b.ino, Number(a.nlink)];
        } catch {
          return [dest, false, 0];
        }
      });
      expect.soft(identity, `[hard-link-identity] ${host}: every file is the same file as its anchor, with two names`).toEqual(dests(host).map((dest) => [dest, true, 2]));
      if (!WINDOWS) {
        const modes = [...dests(host), ...stateFiles].map((rel) => (fs.existsSync(at(w, rel)) ? (fs.statSync(at(w, rel)).mode & 0o777).toString(8) : "absent"));
        expect.soft([...new Set(modes)], `[owner-only-mode] ${host}: installed files and every file of the state directory are for the owner only`).toEqual(["600"]);
      }
      expect.soft(dests(host).filter((dest) => !fs.existsSync(at(w, dest)) || !fs.readFileSync(at(w, dest)).equals(fs.readFileSync(join(ROOT, ...sourceOf(host, dest).split("/"))))),
        `[inventory] ${host}: installed bytes equal the packaged bytes`).toEqual([]);

      // What the installed text names, read from the workspace. A link is relative to the file
      // that holds it; a name in the bootstrap file is relative to the workspace.
      const isInstalled = (rel: string) => dests(host).includes(rel) && fs.lstatSync(at(w, rel), { throwIfNoEntry: false })?.isFile() === true;
      const linked = new Set<string>();
      const brokenLinks: string[] = [];
      const notInstalled = new Set<string>();
      const foldersNotInstalled = new Set<string>();
      const absentCommands: string[] = [];
      const texts = dests(host).filter((dest) => dest.endsWith(".md"));
      for (const dest of texts) {
        if (!isInstalled(dest)) {
          brokenLinks.push(`${dest} is not installed`);
          continue;
        }
        const here = dest === layout.boot ? "." : posix.dirname(dest);
        const text = fs.readFileSync(at(w, dest), "utf8");
        const names = namesIn(text);
        for (const link of names.links) {
          const target = posix.normalize(posix.join(here, link.split("#")[0]));
          linked.add(target);
          if (/^[a-z]+:/.test(link) || !isInstalled(target)) brokenLinks.push(`${dest} -> ${link}`);
        }
        for (const name of names.files) {
          const target = posix.normalize(posix.join(here, name));
          linked.add(target);
          if (!isInstalled(target)) notInstalled.add(name);
        }
        for (const name of names.folders) {
          if (!fs.lstatSync(at(w, posix.join(here, name)), { throwIfNoEntry: false })?.isDirectory()) foldersNotInstalled.add(name);
        }
        // A command of this program that the text tells the assistant to run would have to exist in this version.
        absentCommands.push(...[...text.matchAll(/\borch\s+[a-z][\w-]*/g)].map((m) => `${dest}: ${m[0]}`),
          ...names.spans.filter((span) => /^(orch|npm|npx|node)(\s|$)/.test(span)).map((span) => `${dest}: ${span}`));
      }
      expect.soft(texts.length, `${host}: 19 text files and one sample file`).toBe(19);
      expect.soft(brokenLinks, `[links-resolve] ${host}: every link in every installed file resolves to an installed pack file`).toEqual([]);
      expect.soft([...notInstalled].sort(), `[named-files-exist] ${host}: a file name in the installed text is an installed file, or one of the four names of the user's notes`).toEqual(NOTES_FILES);
      expect.soft([...foldersNotInstalled].sort(), `[named-folders] ${host}: a folder name in the installed text is an installed folder, or one of the five folders of the user's notes`).toEqual(NOTES_FOLDERS);
      expect.soft(absentCommands, `[no-absent-command] ${host}: the installed text names no command of this program and no package command`).toEqual([]);
      const mustBeReferenced = dests(host).filter((dest) => /\/(agents|workflows)\/[\w-]+\.md$|\/(routing|brief|handoff)\.md$/.test(dest));
      expect.soft(mustBeReferenced.filter((dest) => !linked.has(dest)), `[links-resolve] ${host}: every role file, guide and sibling is named from the pack`).toEqual([]);
      expect.soft(mustBeReferenced.length, `${host}: 5 roles, 9 guides, 3 siblings`).toBe(17);

      // The bootstrap file and the first lines of the skill name the files to read first; each is there.
      const read = (rel: string) => (isInstalled(rel) ? fs.readFileSync(at(w, rel), "utf8") : "");
      const bootNames = namesIn(read(layout.boot)).spans.filter((span) => span.startsWith(`${layout.root}/`));
      expect.soft([...new Set(bootNames)], `[first-reads-exist] ${host}: the bootstrap file names the skill, then the notes guide, then the memory guide, by workspace path`)
        .toEqual([`${layout.root}/SKILL.md`, `${layout.root}/workflows/notes.md`, `${layout.root}/workflows/memory.md`]);
      expect.soft(bootNames.filter((rel) => !isInstalled(rel)), `[first-reads-exist] ${host}: and each of them is installed at that path`).toEqual([]);
      const firstLines = read(`${layout.root}/SKILL.md`).split("\n# ")[0];
      expect.soft([...new Set(namesIn(firstLines).links)], `[first-reads-exist] ${host}: the first lines of the skill name the notes, memory, knowledge and learning guides`)
        .toEqual(["workflows/notes.md", "workflows/memory.md", "workflows/knowledge.md", "workflows/learning.md"]);
      expect.soft(namesIn(firstLines).links.filter((link) => !isInstalled(`${layout.root}/${link}`)), `[first-reads-exist] ${host}: and each of them is installed`).toEqual([]);
      expect.soft(sha(read(layout.boot)), `[bootstrap-reviewed] ${host}: the bootstrap file holds the reviewed text`).toBe(hashOfDest(host, layout.boot));

      // Install creates no notes and no ignore rule; the guides tell the assistant to ask first, and the documentation says so.
      expect.soft(["workspace-notes", ".ignore", ".gitignore"].filter((name) => fs.lstatSync(join(w, name), { throwIfNoEntry: false })), `[no-notes-created] ${host}: install creates neither workspace-notes nor an ignore file`).toEqual([]);
      const docs = fs.readFileSync(join(ROOT, "docs", "lead-install.md"), "utf8");
      expect.soft([
        docs.includes("Install does not create `workspace-notes/` or `.ignore`."),
        docs.includes("The guides tell the assistant to ask before the first personal save and before the `.ignore` rule is added."),
        read(`${layout.root}/workflows/memory.md`).includes("then ask to save them.\nWait for acceptance before creating the folder, note or index"),
        read(`${layout.root}/workflows/notes.md`).includes("if absent, stop the save and ask to add it, without editing ignore files before acceptance."),
      ], `[ask-before-first-save] ${host}: the documentation says what install leaves alone and what the installed guides ask for`).toEqual([true, true, true, true]);
    }
  });

  it("lead_loader_refuses_text_that_is_not_the_reviewed_text", async () => {
    const cases: [string, (root: string) => void, RegExp][] = [
      ["one changed sentence", (root) => fs.appendFileSync(join(root, "templates", "lead", "SKILL.md"), "Extra.\n"), /is not the reviewed text/],
      ["a missing file", (root) => fs.unlinkSync(join(root, "templates", "lead", "agents", "reader.md")), /cannot be read \(ENOENT\)/],
      ["a link in place of a file", (root) => {
        const file = join(root, "templates", "workflows", "memory.md");
        fs.renameSync(file, `${file}.real`);
        fs.symlinkSync(`${file}.real`, file);
      }, /cannot be read \((ELOOP|EMLINK)\)/],
      ["a file above the size limit", (root) => fs.writeFileSync(join(root, "templates", "lead", "brief.md"), Buffer.alloc(128 * 1024 + 1, 0x61)), /larger than 131072 bytes/],
      ["bytes that are not UTF-8", (root) => fs.writeFileSync(join(root, "templates", "lead", "handoff.md"), Buffer.from([0xff, 0xfe, 0x00])), /is not UTF-8 text/],
    ];
    expect(fs.existsSync(join(ROOT, "templates", "lead", "SKILL.md")), "[loader-refuses] the packaged text exists").toBe(true);
    for (const [name, damage, message] of cases) {
      const { base, w } = workspace();
      const root = join(base, "package");
      fs.cpSync(join(ROOT, "templates"), join(root, "templates"), { recursive: true });
      damage(root);
      const r = await inProcess(["install", "--workspace", w, "--host", "claude"], { packageRoot: root });
      expect.soft([r.code, message.test(r.err), tree(w)], `[loader-refuses] ${name}: exit 1, the reason, and an untouched workspace\n${r.err}`).toEqual([1, true, []]);
    }
  });

  it("lead_short_io_never_publishes_partial_bytes", async () => {
    // File calls that pass through to the real ones, with reads and writes cut short or failing.
    type Rule = { short?: number; zeroAt?: string; errorAt?: string; lieAt?: string };
    const wrap = (rule: Rule) => {
      const paths = new Map<number, string>();
      const failed = new Set<string>();
      let ticks = 0;
      const wrapped = {
        ...fs,
        realpathSync: fs.realpathSync,
        openSync: (path: string, flags: number, mode?: number) => {
          const fd = fs.openSync(path, flags, mode);
          paths.set(fd, path.split(sep).join("/"));
          return fd;
        },
        readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => fs.readSync(fd, buffer, offset, Math.min(length, rule.short ?? length), position),
        writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
          const path = paths.get(fd) ?? "";
          if (rule.zeroAt && path.endsWith(rule.zeroAt)) return 0;
          if (rule.errorAt && path.endsWith(rule.errorAt)) {
            if (failed.has(path)) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
            failed.add(path);
            return fs.writeSync(fd, buffer, offset, Math.min(length, 4));
          }
          if (rule.lieAt && path.endsWith(rule.lieAt)) {
            fs.writeSync(fd, buffer, offset, Math.floor(length / 2));
            return length;
          }
          return fs.writeSync(fd, buffer, offset, Math.min(length, rule.short ?? length));
        },
      };
      // A clock that moves a little at every question: a loop that never ends runs out of time.
      // The recorded installer id is one of a process that has ended, as after a real install.
      return { fs: wrapped, now: () => (ticks += 0.01), pid: spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 }).pid };
    };
    const publishedWrong = (w: string) => dests("claude").filter((dest) => fs.existsSync(at(w, dest)) && sha(fs.readFileSync(at(w, dest))) !== hashOfDest("claude", dest));
    const published = (w: string) => dests("claude").filter((dest) => fs.existsSync(at(w, dest)));
    const args = (w: string) => ["--workspace", w, "--host", "claude"];

    // Short reads and writes of 3 bytes each still give complete files.
    {
      const { w } = workspace();
      const r = await inProcess(["install", ...args(w)], wrap({ short: 3 }));
      expect.soft([r.code, resultOf(r.out)], `[short-io-completes] install with 3-byte reads and writes\n${r.out}${r.err}`).toEqual([0, "INSTALLED"]);
      expect.soft(publishedWrong(w), "[no-partial-published] short writes: no destination holds anything but the reviewed text").toEqual([]);
      expect.soft(published(w).length, "[short-io-completes] all 20 files are there").toBe(20);
      const status = lead("status", ...args(w));
      expect.soft([status.code, resultOf(status.out)], "[short-io-completes] a fresh status agrees").toEqual([0, "INSTALLED"]);
    }
    // A write that reports zero bytes stops the install; nothing was published.
    {
      const { w } = workspace();
      const r = await inProcess(["install", ...args(w)], wrap({ zeroAt: ".orch-lead-install/objects/03" }));
      expect.soft([r.code, /stopped at: .*objects.03 \(.*write returned 0\)/.test(r.out), published(w)], `[zero-write-stops] a zero write is an error at that anchor\n${r.out}${r.err}`).toEqual([1, true, []]);
      expect.soft(resultOf(r.out), "[zero-write-stops] and the run is reported as partial").toBe("PARTIAL");
    }
    // A write error after 4 bytes: the partial anchor stays, is reported, and is never linked.
    {
      const { w } = workspace();
      const partial = ".orch-lead-install/objects/05";
      const r = await inProcess(["install", ...args(w)], wrap({ errorAt: partial }));
      expect.soft([r.code, resultOf(r.out), published(w), fs.existsSync(at(w, partial)) ? fs.statSync(at(w, partial)).size : -1],
        `[no-partial-published] a failed anchor write: exit 1, PARTIAL, nothing published, 4 bytes in the anchor\n${r.out}${r.err}`).toEqual([1, "PARTIAL", [], 4]);
      const status = lead("status", ...args(w));
      expect.soft(status.out, "[no-partial-published] status names the partial anchor").toContain(`anchor without the reviewed text: ${at(w, partial)}`);
      const uninstall = lead("uninstall", ...args(w));
      expect.soft([uninstall.code, fs.existsSync(at(w, partial)) ? fs.statSync(at(w, partial)).size : -1, uninstall.out.includes(`state preserved ${at(w, partial)}`)],
        `[no-partial-published] uninstall keeps and lists the partial anchor\n${uninstall.out}`).toEqual([2, 4, true]);
    }
    // A write that claims success for bytes it did not write is caught by reading the anchor back.
    {
      const { w } = workspace();
      const r = await inProcess(["install", ...args(w)], wrap({ lieAt: ".orch-lead-install/objects/02" }));
      expect.soft([r.code, r.out.includes("the bytes read back differ"), published(w)], `[no-partial-published] an anchor that does not read back is never linked\n${r.out}${r.err}`).toEqual([1, true, []]);
    }
    // Short writes that a broken loop would take for complete ones: still no partial destination.
    {
      const { w } = workspace();
      await inProcess(["install", ...args(w)], wrap({ short: 7 }));
      expect.soft(publishedWrong(w), "[no-partial-published] 7-byte writes: no destination holds part of a file").toEqual([]);
    }
  });
});
