// SPDX-License-Identifier: LicenseRef-PolyForm-Internal-Use-1.0.0 OR LicenseRef-PolyForm-Noncommercial-1.0.0
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROBE = fileURLToPath(new URL("./fixtures/learning/probe.mjs", import.meta.url));
const CANARIES = ["TOP_CANARY", "DYNAMIC_CANARY", "CALLBACK_CANARY", "GETTER_CANARY"];
const roots: string[] = [];

type Record = {
  probe: string;
  fs_read: string[];
  env: string[];
  runtime: { loaded: string[]; env: string[] };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "learning-probe-attribution-"));
  roots.push(root);
  const probe = join(root, "probe.mjs");
  copyFileSync(PROBE, probe);
  return { root, probe };
}

function run(probe: string, program: string, root: string): Record {
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, program], {
    cwd: root,
    env: {
      HOME: root,
      USERPROFILE: root,
      TOP_CANARY: "top",
      DYNAMIC_CANARY: "dynamic",
      CALLBACK_CANARY: "callback",
      GETTER_CANARY: "getter",
      FUNCTION_CANARY: "function",
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  expect([child.status, child.signal, child.stderr], "the program exits successfully").toEqual([0, null, ""]);
  const record: Record = JSON.parse(String(child.output[3]));
  expect(record.probe, "the probe wrote its record").toBe("learning-probe");
  return record;
}

describe("LearningProbeAttribution", () => {
  const W1 = "W1 attributes top-level, dynamic-import, timer and getter reads to the program: %s";
  const SHAPES: [string, string][] = [
    ["plain", "plain"],
    ["paren(x)", "paren(x)"],
    ["space", "with space"],
    ["hash", "with#hash"],
    ["non-ASCII", "路径"],
    ["text at", "x at y"],
    ["probe-url-prefix beside the probe", "."],
  ];
  // A directory name cannot contain a colon on Windows, so these two shapes cannot exist there.
  const COLON_SHAPES: [string, string][] = [
    ["node:internal/modules", "node:internal/modules"],
    ["node:internal/modules with paren(x)", "node:internal/modules/paren(x)"],
  ];
  const attributesReadsToTheProgram = (shape: string, relative: string) => {
    const { root, probe } = world();
    const dir = join(root, relative);
    mkdirSync(dir, { recursive: true });
    const program = join(dir, shape === "probe-url-prefix beside the probe" ? "probe.mjs.program.mjs" : "program.mjs");
    const canary = join(root, "canary.txt");
    writeFileSync(canary, "synthetic private file");
    const prefix = `import { readFileSync } from "node:fs";
const canary = ${JSON.stringify(canary)};
`;
    writeFileSync(join(dir, "dynamic.mjs"), prefix + `
readFileSync(canary);
void process.env.DYNAMIC_CANARY;
`);
    writeFileSync(program, prefix + `
readFileSync(canary);
void process.env.TOP_CANARY;
await import("./dynamic.mjs");
await new Promise((resolve) => setTimeout(() => {
  readFileSync(canary);
  void process.env.CALLBACK_CANARY;
  resolve();
}, 1));
const object = {
  get value() {
    readFileSync(canary);
    return process.env.GETTER_CANARY;
  },
};
void object.value;
`);
    const record = run(probe, program, root);
    expect(record.env.filter((name) => CANARIES.includes(name)), "all four canary variables are PROGRAM reads").toEqual(CANARIES);
    expect(record.fs_read.filter((name) => name === "fs.readFileSync"), "all four canary file reads are PROGRAM reads").toHaveLength(4);
    expect(record.runtime.loaded, "the runtime did not load the canary file").not.toContain(canary);
    expect(record.runtime.env.filter((name) => CANARIES.includes(name)), "no canary variable is a runtime read").toEqual([]);
  };
  it.each(SHAPES)(W1, attributesReadsToTheProgram);
  describe.skipIf(process.platform === "win32")("path shapes with a colon", () => {
    it.each(COLON_SHAPES)(W1, attributesReadsToTheProgram);
  });

  it("W2 known limit: a new Function timer callback without a program file on the stack records its environment read as runtime", () => {
    const { root, probe } = world();
    const program = join(root, "program.mjs");
    writeFileSync(program, `
setTimeout(new Function("void process.env.FUNCTION_CANARY;"), 1);
`);
    const record = run(probe, program, root);
    expect(record.env, "the fileless callback is absent from PROGRAM reads").not.toContain("FUNCTION_CANARY");
    expect(record.runtime.env, "the fileless callback is recorded as runtime today").toContain("FUNCTION_CANARY");
  });
});
