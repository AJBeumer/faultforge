/**
 * The house rule that a helper two scripts need lives in one named module (AUD-N1), checked for the three that
 * had been copied: the SHA-256 helper and the tool name (`provenance.ts`) and JSON Lines reading (`jsonl.ts`).
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, TOOL } from "../shared/provenance.ts";
import { SRC, sourceFiles } from "./sources.ts";

const sources = sourceFiles().map((path) => ({ file: basename(path), text: readFileSync(join(SRC, path), "utf8") }));

const filesMatching = (pattern: RegExp) =>
  sources
    .filter(({ text }) => pattern.test(text))
    .map(({ file }) => file)
    .sort();

describe("helpers that live in one module (AUD-N1)", () => {
  it("defines sha256 once", () => {
    expect(filesMatching(/function sha256\(/)).toEqual(["provenance.ts"]);
  });

  it("hashes only through it: no other module builds a hash of its own", () => {
    const inline = filesMatching(/createHash\(/);
    // The door's run gate (#347) hashes its runner key itself: the door imports only files the guard holds, and
    // provenance.ts isn't one (target-post-door.test.ts).
    expect(inline).toEqual(["provenance.ts", "target-post-run.ts"]);
  });

  it("builds the tool name once", () => {
    expect(filesMatching(/faultforge-harness@/)).toEqual(["provenance.ts"]);
  });

  it("parses JSON Lines once", () => {
    // A split on newlines followed, within a few lines, by a JSON.parse of each line.
    expect(filesMatching(/\.split\("\\n"\)[\s\S]{0,160}?JSON\.parse\(line/)).toEqual(["jsonl.ts"]);
  });

  it("gives the tool name with the package version and a hex hash", () => {
    expect(TOOL).toMatch(/^faultforge-harness@\d+\.\d+\.\d+/);
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
