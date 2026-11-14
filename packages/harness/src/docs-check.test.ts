import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DocsFacts, docsProblems, publicFiles } from "./docs-check.ts";

const facts: DocsFacts = {
  adjudicated: new Set(["FF-0001", "FF-0003", "FF-0004"]),
  caseTemplates: new Map([
    ["FF-0001", ["seed-v1"]],
    ["FF-0002", ["pending-v1"]],
    ["FF-0003", ["held-v1"]],
    // A duplicate entry naming an ordinary template can't hide that the case is held out (Qodo on PR 232).
    ["FF-0004", ["held-v1", "seed-v1"]],
  ]),
  privateTemplates: ["pending-v1", "held-v1", "unused-v1"],
  heldOut: new Set(["held-v1"]),
};
const check = (text: string) => docsProblems([{ path: "docs/x.md", text }], facts);

describe("docsProblems (#224, audit M-24)", () => {
  it("allows an adjudicated case and its template, and ids the answer key doesn't hold", () => {
    expect(check("FF-0001 was caught; see seed-v1. A fixture uses FF-0099.")).toEqual([]);
  });

  it("refuses a case, or its template, before its verdict", () => {
    expect(check("Next up: FF-0002")).toEqual(["docs/x.md: names FF-0002, which has no verdict yet"]);
    expect(check("before the pending-v1 case")).toEqual(["docs/x.md: names pending-v1, whose case has no verdict yet"]);
    expect(check("unused-v1 is ready")).toEqual(["docs/x.md: names unused-v1, whose case has no verdict yet"]);
  });

  it("refuses a held-out case or template even after its verdict", () => {
    expect(check("FF-0003 and held-v1")).toEqual([
      "docs/x.md: names FF-0003, a held-out case",
      "docs/x.md: names held-v1, a held-out template",
    ]);
  });

  it("reads every spelling of a case id, and a duplicate entry can't hide a held-out case (Qodo on PR 232)", () => {
    expect(check("see ff-0002 and FF0003")).toEqual([
      "docs/x.md: names FF-0002, which has no verdict yet",
      "docs/x.md: names FF-0003, a held-out case",
    ]);
    expect(check("FF 0004")).toEqual(["docs/x.md: names FF-0004, a held-out case"]);
  });
});

describe("publicFiles: the staged copy too (Qodo on PR 232)", () => {
  it("reads a public file's staged copy when the working copy differs", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-check-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet", "-b", "main");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), "# Lab\n");
    writeFileSync(join(root, "docs", "log.md"), "Next up: FF-0002\n");
    git("add", ".");
    // Edited after staging: the commit would still record the staged text.
    writeFileSync(join(root, "docs", "log.md"), "Nothing to see\n");
    const files = publicFiles(root);
    expect(files.find((f) => f.path === "docs/log.md (staged)")?.text).toBe("Next up: FF-0002\n");
    expect(docsProblems(files, facts)).toEqual(["docs/log.md (staged): names FF-0002, which has no verdict yet"]);
  });
});

describe("docsProblems: an id above every case in the answer key (#244)", () => {
  it("refuses an id past the highest case, unless it is a fixture id", () => {
    expect(check("Next up is FF-0005.")).toEqual([
      "docs/x.md: names FF-0005, above the highest case in the answer key",
    ]);
    expect(check("Fixtures use FF-0099 and FF-9001.")).toEqual([]);
  });

  it("allows an id below the highest case that the answer key doesn't hold, as before", () => {
    const sparse: DocsFacts = { ...facts, caseTemplates: new Map([["FF-0004", ["seed-v1"]]]) };
    expect(docsProblems([{ path: "docs/x.md", text: "FF-0002" }], sparse)).toEqual([]);
  });
});

describe("docsProblems: a malformed id in the answer key (Qodo on PR 264)", () => {
  it("still refuses an id above the highest well-formed case", () => {
    const odd: DocsFacts = { ...facts, caseTemplates: new Map([...facts.caseTemplates, ["FF-X", ["seed-v1"]]]) };
    expect(docsProblems([{ path: "docs/x.md", text: "FF-0005" }], odd)).toEqual([
      "docs/x.md: names FF-0005, above the highest case in the answer key",
    ]);
  });
});
