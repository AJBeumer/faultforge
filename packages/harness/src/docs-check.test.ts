import { describe, expect, it } from "vitest";
import { type DocsFacts, docsProblems } from "./docs-check.ts";

const facts: DocsFacts = {
  adjudicated: new Set(["FF-0001", "FF-0003"]),
  caseTemplates: new Map([
    ["FF-0001", "seed-v1"],
    ["FF-0002", "pending-v1"],
    ["FF-0003", "held-v1"],
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
});
