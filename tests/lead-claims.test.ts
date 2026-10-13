// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
// The reviewed text of the lead pack and of its documentation.
//
// tests/fixtures/lead-reviewed-text.json holds, written by hand: the SHA-256 of every reviewed
// file, every sentence of those files with its class, the README lines about the pack, and every
// fixed string the commands print. A changed byte or an unlisted sentence fails here until a
// person has read the text again and edited the fixture; nothing regenerates it.
//
// A hash shows that the bytes are the reviewed bytes. It does not show that a sentence is true.
// So every sentence about what the program does names, in tests/fixtures/lead-claims.json, a test
// of the real CLI, the bracketed label of one assertion in it, and a source change that makes
// the sentence false; tests/lead-mutations.test.ts applies each change and requires that
// assertion to fail. Sentences that instruct the assistant are not program claims: that the text
// exists says nothing about whether an assistant follows it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./_helpers.js";

const FROZEN = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "lead-reviewed-text.json"), "utf8"));
const WITNESS = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "lead-claims.json"), "utf8"));
interface Unit { text: string; class: string; claim?: string }
const read = (rel: string): Buffer => (existsSync(join(ROOT, ...rel.split("/"))) ? readFileSync(join(ROOT, ...rel.split("/"))) : Buffer.alloc(0));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The sentences of one file: headings, table rows, code lines and data lines whole; prose split at sentence ends. */
function unitsOf(file: string, text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (!line || line === "---" || /^\|[-| ]+\|$/.test(line)) continue;
    if (fence || file.endsWith(".csv") || line.startsWith("|") || line.startsWith("#")) {
      out.push(line);
      continue;
    }
    out.push(...line.replace(/^(?:[-*]|\d+\.)\s+/, "").split(/(?<=[.?!])\s+(?=[A-Z`[(])/).filter(Boolean));
  }
  return out;
}

describe("orch lead: reviewed text", () => {
  it("lead_reviewed_sentences_and_behavior_claims", () => {
    const reviewed: Record<string, string> = { ...FROZEN.sources, ...FROZEN.documents };
    expect(Object.keys(FROZEN.sources).length, "18 packaged files").toBe(18);
    expect(Object.keys(FROZEN.units).sort(), "every reviewed file has a sentence list").toEqual(Object.keys(reviewed).sort());
    const everything: [string, Unit][] = [];
    for (const [file, hash] of Object.entries(reviewed)) {
      const bytes = read(file);
      expect.soft(sha(bytes), `[reviewed-hash] ${file} is not the text that was read and approved; read it again, then edit the fixture by hand`).toBe(hash);
      expect.soft([bytes.includes(13), bytes.length > 0 && bytes[bytes.length - 1] === 10], `${file}: LF line ends, final newline`).toEqual([false, true]);
      const units: Unit[] = FROZEN.units[file];
      expect.soft(unitsOf(file, bytes.toString("utf8")), `[sentence-inventory] ${file}: every sentence is listed and classified, in order`).toEqual(units.map((u) => u.text));
      for (const unit of units) everything.push([file, unit]);
    }
    // README lines about the pack: present, and classified like the rest.
    for (const [file, units] of Object.entries(FROZEN.readme as Record<string, Unit[]>)) {
      const text = read(file).toString("utf8");
      for (const unit of units) {
        expect.soft(text.includes(unit.text), `[sentence-inventory] ${file} has the reviewed line: ${unit.text}`).toBe(true);
        everything.push([file, unit]);
      }
      const about = text.split("\n").filter((line) => /orch lead|lead-install/.test(line));
      expect.soft(about.filter((line) => !units.some((u) => line.includes(u.text))), `[sentence-inventory] ${file}: no other line mentions the lead pack`).toEqual([]);
    }
    // Every fixed string of the commands, read from the source text of the table that holds them.
    const table = /export const LEAD_TEXT = \{\n([\s\S]*?)\n\} as const;/.exec(read("src/lead/cli.ts").toString("utf8"))?.[1] ?? "";
    const printed: Record<string, string> = {};
    for (const line of table.split("\n")) {
      const m = /^ {2}(\w+): (".*"),$/.exec(line);
      expect.soft(m !== null || line === "", `[sentence-inventory] command text line can be read: ${line}`).toBe(true);
      if (m) printed[m[1]] = JSON.parse(m[2]);
    }
    expect.soft(printed, "[sentence-inventory] the fixed strings of the commands are the reviewed ones").toEqual(Object.fromEntries(Object.entries(FROZEN.cli_text as Record<string, Unit>).map(([key, u]) => [key, u.text])));
    for (const unit of Object.values(FROZEN.cli_text as Record<string, Unit>)) everything.push(["src/lead/cli.ts", unit]);

    // Classes, and a witness for every sentence about program behaviour.
    const tests: Record<string, string> = {};
    const mutants: { id: string; test_file: string; test: string; markers: string[] }[] = WITNESS.mutants;
    let claims = 0;
    for (const [file, unit] of everything) {
      expect.soft(FROZEN.classes.includes(unit.class), `[sentence-inventory] ${file}: known class for: ${unit.text}`).toBe(true);
      if (unit.class !== "program-claim") {
        expect.soft(unit.claim, `${file}: only a program claim names a witness: ${unit.text}`).toBeUndefined();
        continue;
      }
      claims += 1;
      const witness = WITNESS.claims[unit.claim ?? ""];
      expect.soft(witness, `[claim-witness] ${file}: a witness is named for: ${unit.text}`).toBeDefined();
      if (!witness) continue;
      tests[witness.test_file] ??= read(witness.test_file).toString("utf8");
      const mutant = mutants.find((m) => m.id === witness.mutant);
      expect.soft([tests[witness.test_file].includes(`it("${witness.test}"`), tests[witness.test_file].includes(`[${witness.marker}]`),
        mutant?.test_file === witness.test_file && mutant?.test === witness.test && mutant?.markers.includes(witness.marker)],
      `[claim-witness] ${unit.claim}: the test, the labelled assertion and a falsifying change exist for: ${unit.text}`).toEqual([true, true, true]);
    }
    expect.soft(claims, "the documentation and the command text make program claims").toBeGreaterThan(40);
    // The pack itself tells the assistant what to do. It promises nothing about the program, the
    // host or a worker: such a sentence would need a behavioural witness, and has none here.
    const packClaims = everything.filter(([file, unit]) => file.startsWith("templates/") && unit.class !== "instruction" && unit.class !== "explanatory");
    expect.soft(packClaims.map(([file, unit]) => `${file}: ${unit.text}`), "[sentence-inventory] no packaged sentence is a program claim").toEqual([]);
    for (const mutant of mutants) {
      tests[mutant.test_file] ??= read(mutant.test_file).toString("utf8");
      expect.soft([tests[mutant.test_file].includes(`it("${mutant.test}"`), mutant.markers.filter((marker) => !tests[mutant.test_file].includes(`[${marker}]`))],
        `[claim-witness] mutant ${mutant.id} names an existing test and labels`).toEqual([true, []]);
    }
  });

  it("lead_sample_rows_are_the_five_the_guide_would_find", () => {
    // A calculation on the packaged sample only. It does not show what any assistant answers.
    const rows = read("templates/workflows/sample-customers.csv").toString("utf8").trim().split("\n").slice(1).map((line) => line.split(","));
    const overdue = rows.filter(([, , due, status]) => status === "open" && due < "2026-10-14").sort((a, b) => (a[2] < b[2] ? -1 : 1)).map(([id]) => id);
    expect(overdue).toEqual(["C103", "C101", "C105", "C102", "C104"]);
  });
});
