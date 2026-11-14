import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonLines, readJsonLines } from "./jsonl.ts";

describe("parseJsonLines", () => {
  it("reads one value per line and skips blank lines, CRLF or not", () => {
    expect(parseJsonLines('{"a":1}\n\n  \n{"a":2}\r\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("names the line that isn't JSON, so a damaged file is never read as a shorter one", () => {
    expect(() => parseJsonLines('{"a":1}\n{"a":\n')).toThrow(/line 2 is not JSON/);
  });
});

describe("readJsonLines", () => {
  it("reads a file, and throws when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    try {
      const file = join(dir, "x.jsonl");
      writeFileSync(file, '{"caseId":"FF-9001"}\n');
      expect(readJsonLines(file)).toEqual([{ caseId: "FF-9001" }]);
      expect(() => readJsonLines(join(dir, "missing.jsonl"))).toThrow();
      // A bad line names its file, so a message about two ledgers says which one (Qodo on PR 260).
      const bad = join(dir, "bad.jsonl");
      writeFileSync(bad, "{}\nnot json\n");
      expect(() => readJsonLines(bad)).toThrow(`${bad}: line 2 is not JSON`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
