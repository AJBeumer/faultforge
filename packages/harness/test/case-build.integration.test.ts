import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/case-build.ts";
import { privateDir } from "../src/templates.ts";

const root = join(import.meta.dirname, "../../..");
// private/ is this repo's own git-ignored evidence store (CLAUDE.md): a checkout that doesn't have
// it — a bare clone of the public repo, or revert:check's scratch copy, which is built from git alone
// — can't run this test at all. Skipped, not failed, so it doesn't falsely look like the PR's change
// broke something when the real cause is that the evidence simply isn't there to check against.
// The guard looks where `run` looks (`privateDir`, which honours FAULTFORGE_PRIVATE_DIR), so the test
// never skips with the evidence present under an override path, or runs against one that lacks it.
const hasPrivateEvidence = existsSync(join(privateDir(process.env), "ground-truth.jsonl"));

/** FF-0001's review predates `review:wait` (#11's notes); this is the one real case to regenerate. */
describe.skipIf(!hasPrivateEvidence)("case:build against the real FF-0001 evidence (#11)", () => {
  it("regenerates examples/FF-0001.json byte for byte", async () => {
    const lines: string[] = [];
    const code = await run("FF-0001", { log: (line) => lines.push(line), error: (line) => lines.push(line) });
    expect(code).toBe(0);
    const printed = lines.filter((l) => !l.startsWith("[case:build]")).join("\n");
    const expected = readFileSync(join(root, "examples/FF-0001.json"), "utf8").trimEnd();
    expect(printed).toBe(expected);
  });
});
