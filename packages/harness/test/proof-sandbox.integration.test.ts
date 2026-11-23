/**
 * The verifier against a real commit: an honest proof earns a certificate, and the same proof whose test also
 * reads a file outside its export earns none, because the test runs under Node's permission model. Before the
 * sandbox (23 November), that second bundle was certified. Skips itself when the commit isn't in this clone
 * (a shallow checkout).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "../src/fixtures/temp-dir.ts";
import { verifyBundle } from "../src/proof/proof-run.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const COMMIT = "e45269d"; // `normalisePath` strips one leading "./" at line 54 here
const CITED = { file: "packages/harness/src/match/match-rule.ts", start: 54, end: 54 };
const present = spawnSync("git", ["-C", REPO, "cat-file", "-e", `${COMMIT}^{commit}`]).status === 0;
const scratch = tempDir("proof-sandbox-");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bundle(name: string, body: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const fix = { start: 54, end: 54, lines: ['  return path.replace(/\\\\/g, "/").replace(/^(\\.\\/)+/, "");'] };
  const testPath = "packages/harness/src/match/normalise.proof.test.ts";
  writeFileSync(join(dir, "proof.json"), JSON.stringify({ verdict: "supported", testPath, cause: "one ./ only", fix }));
  const imports = 'import { readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\n';
  writeFileSync(join(dir, "proof.test.ts"), `${imports}import { normalisePath } from "./match-rule.ts";\n${body}\n`);
  return dir;
}

describe.skipIf(!present)("proof:verify's sandbox", () => {
  it("certifies an honest proof", () => {
    const honest = bundle(
      "honest",
      'it("strips every ./", () => { expect(normalisePath("././a.ts")).toBe("a.ts"); });',
    );
    const cert = verifyBundle(REPO, COMMIT, CITED, honest, join(scratch, "out-honest"));
    expect(cert.reasons).toEqual([]);
    expect(cert.certified).toBe(true);
  }, 600_000);

  it("refuses the same proof when its test reads a file outside the export", () => {
    // Built from its segments at run time, as an evasion would: the static path check can't see it, the sandbox must.
    const outside = JSON.stringify(join(REPO, "package.json").replace(/\\/g, "/").split("/")).replace(/^\[|\]$/g, "");
    const hostile = bundle(
      "hostile",
      `it("strips every ./", () => {\n  const leaked = readFileSync([${outside}].join("/"), "utf8");\n` +
        '  expect(normalisePath("././a.ts")).toBe(leaked.length > 0 ? "a.ts" : "never");\n});',
    );
    const cert = verifyBundle(REPO, COMMIT, CITED, hostile, join(scratch, "out-hostile"));
    expect(cert.certified).toBe(false);
    expect(cert.reviewed).toBe("error");
  }, 600_000);
});
