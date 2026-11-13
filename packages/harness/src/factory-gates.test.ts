import { describe, expect, it } from "vitest";
import { reviewerRuleGates } from "./factory-gates.ts";

const pages = (...names: (string | { filename: string; previous_filename?: string })[]) => [
  names.map((n) => (typeof n === "string" ? { filename: n } : n)),
];

describe("reviewerRuleGates (#215)", () => {
  it("is empty for a PR that touches no reviewer rule file", () => {
    expect(reviewerRuleGates(pages("src/bookings/list.ts", "README.md", "docs/AGENTS-notes.md"))).toEqual([]);
  });

  it("gates AGENTS.md and INVARIANTS.md at any depth, and Qodo's own config", () => {
    for (const name of ["AGENTS.md", "INVARIANTS.md", "packages/x/AGENTS.md", ".pr_agent.toml", ".qodo/rules.yml"]) {
      expect(reviewerRuleGates(pages("src/a.ts", name))).toEqual([expect.stringContaining(name)]);
    }
  });

  it("gates a rule file renamed away, and finds one on a later page", () => {
    expect(reviewerRuleGates(pages({ filename: "OLD.md", previous_filename: "AGENTS.md" }))).toEqual([
      expect.stringContaining("AGENTS.md"),
    ]);
    expect(reviewerRuleGates([[{ filename: "src/a.ts" }], [{ filename: "INVARIANTS.md" }]])).toEqual([
      expect.stringContaining("INVARIANTS.md"),
    ]);
  });

  it("gates a list it can't read: not knowing is never read as no change", () => {
    for (const unreadable of [null, { state: "OPEN" }, [{ filename: "a.ts" }], [[{ name: "a.ts" }]]]) {
      expect(reviewerRuleGates(unreadable)).toEqual([expect.stringContaining("couldn't read")]);
    }
  });
});
