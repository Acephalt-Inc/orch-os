import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const usage = { code: 2, out: "", err: "vectors connect-local: USAGE\n" };
const refused = { code: 1, out: "", err: "vectors connect-local: REFUSED\n" };

async function cli(args: string[]) {
  let out = "";
  let err = "";
  const code = await main(["vectors", ...args], {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdin: () => "",
  });
  return { code, out, err };
}

describe("vectors CLI dispatch", () => {
  it("command_grammar_usage", async () => {
    for (const args of [[], ["connect-local"], ["connect-local", "--apply", "--url", "http://127.0.0.1:1"]]) {
      expect(await cli(args)).toEqual(usage);
    }
  });

  it("url_refused_before_transport", async () => {
    expect(await cli(["connect-local", "--preview", "--url", "http://example.com:80"])).toEqual(refused);
  });

  it("preview_unreachable_from_index_recall", () => {
    const src = resolve("src");
    const roots = ["memory", "memory-semantic", "knowledge"].flatMap((directory) =>
      readdirSync(join(src, directory)).filter((name) => name.endsWith(".ts")).map((name) => join(src, directory, name)));
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      expect(file).not.toContain("/vectors-local/");
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/g)];
      for (const match of imports) walk(resolve(dirname(file), match[1].replace(/\.js$/, ".ts")));
    };
    for (const file of roots) walk(file);
    const cliSource = readFileSync(join(src, "cli.ts"), "utf8");
    expect(cliSource).toContain('import("./vectors-local/command.js")');
    const production = readdirSync(src, { recursive: true }).map(String)
      .filter((file) => file.endsWith(".ts") && file !== "cli.ts" && !file.startsWith("vectors-local/"));
    for (const file of production) expect(readFileSync(join(src, file), "utf8")).not.toContain("vectors-local/");
  });
});
