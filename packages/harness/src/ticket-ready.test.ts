import { describe, expect, it } from "vitest";
import { readinessProblems, SECTIONS } from "./ticket-ready.ts";

const ready = `### Result
A thing exists.

### Done when
- [ ] It works

### Must not break
- The other thing

### Why
Because.`;

describe("readinessProblems", () => {
  it("accepts a ticket with every section and no open blockers", () => {
    expect(readinessProblems(ready, SECTIONS.faultforge, [])).toEqual([]);
  });

  it("names a missing Must not break section", () => {
    const body = ready.replace(/### Must not break[\s\S]*?(?=### Why)/, "");
    expect(readinessProblems(body, SECTIONS.faultforge, [])).toEqual(['missing section "Must not break"']);
  });

  it("treats an empty section as missing", () => {
    const body = ready.replace("- The other thing", "_No response_");
    expect(readinessProblems(body, SECTIONS.faultforge, [])).toEqual(['section "Must not break" is empty']);
  });

  it("needs at least one checklist item in Done when", () => {
    const body = ready.replace("- [ ] It works", "It works, trust me");
    expect(readinessProblems(body, SECTIONS.faultforge, [])).toEqual(['"Done when" has no checklist items']);
  });

  it("lists open blockers", () => {
    expect(readinessProblems(ready, SECTIONS.faultforge, [12, 15])).toEqual(["blocked by open tickets #12, #15"]);
  });

  it("uses the target's own section names", () => {
    const target =
      "### What\nList bookings.\n\n### Acceptance criteria\n- [ ] Lists them\n\n### Must not break\n- Auth";
    expect(readinessProblems(target, SECTIONS.target, [])).toEqual([]);
    expect(readinessProblems(target, SECTIONS.faultforge, [])).toContain('missing section "Result"');
  });

  it("reports every problem at once", () => {
    expect(readinessProblems("### Result\nx", SECTIONS.faultforge, [3])).toEqual([
      'missing section "Done when"',
      'missing section "Must not break"',
      "blocked by open tickets #3",
    ]);
  });
});
