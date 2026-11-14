/**
 * The house rule that a helper two scripts need lives in one named module (AUD-N1), checked for the three that
 * had been copied: the SHA-256 helper and the tool name (`provenance.ts`) and JSON Lines reading (`jsonl.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, TOOL } from "./provenance.ts";

const SRC = import.meta.dirname;
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));

const filesMatching = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe("helpers that live in one module (AUD-N1)", () => {
  it("defines sha256 once", () => {
    expect(filesMatching(/function sha256\(/)).toEqual(["provenance.ts"]);
  });

  it("hashes only through it: no other module builds a hash of its own", () => {
    // factory-workspace.ts is another worker's file, moved over in its own change; it may already be done.
    const inline = filesMatching(/createHash\(/).filter((file) => file !== "factory-workspace.ts");
    expect(inline).toEqual(["provenance.ts"]);
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
