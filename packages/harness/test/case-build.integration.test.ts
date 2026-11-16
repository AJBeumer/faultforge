import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/case/case-build.ts";
import { privateDir } from "../src/shared/templates.ts";

const root = join(import.meta.dirname, "../../..");
// A clone of the public repo, or revert:check's copy built from git, has no private evidence. Skip there
// rather than fail, so a missing folder never reads as a broken change. Look where `run` looks.
const hasPrivateEvidence = existsSync(join(privateDir(process.env), "ground-truth.jsonl"));

/** FF-0001's review was saved by hand, before `review:wait` existed, so it is the one real case to rebuild. */
describe.skipIf(!hasPrivateEvidence)("case:build against the real FF-0001 evidence", () => {
  it("regenerates examples/FF-0001.json byte for byte", async () => {
    const lines: string[] = [];
    const code = await run("FF-0001", { log: (line) => lines.push(line), error: (line) => lines.push(line) });
    expect(code).toBe(0);
    const printed = lines.filter((l) => !l.startsWith("[case:build]")).join("\n");
    const expected = readFileSync(join(root, "examples/FF-0001.json"), "utf8").trimEnd();
    expect(printed).toBe(expected);
  });
});
