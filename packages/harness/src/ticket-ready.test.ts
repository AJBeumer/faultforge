import { describe, expect, it } from "vitest";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { openNumbers, readinessProblems, ticketReadyReport, writtenDependencies } from "./ticket-ready.ts";

const factory = loadFactory();
const SECTIONS = {
  faultforge: repoConfig(factory, "faultforge").tickets,
  target: repoConfig(factory, "target").tickets,
};

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

describe("review findings on PR 53", () => {
  it("treats the form's untouched placeholder as empty", () => {
    const body = ready.replace("- The other thing", "- ");
    expect(readinessProblems(body, SECTIONS.faultforge, [])).toEqual(['section "Must not break" is empty']);
  });

  it("ignores headings and checklists inside code blocks", () => {
    const body = "### Result\nx\n\n### Must not break\n- y\n\n```markdown\n### Done when\n- [ ] example\n```";
    expect(readinessProblems(body, SECTIONS.faultforge, [])).toEqual(['missing section "Done when"']);
  });

  it("reads blockers written in Depends on", () => {
    expect(writtenDependencies(`${ready}\n\n### Depends on\n#12, #15 and target 3`)).toEqual([12, 15]);
  });

  it("finds no written blockers when there is no Depends on section", () => {
    expect(writtenDependencies(ready)).toEqual([]);
  });

  it("finds an open blocker on a later page", () => {
    const page1 = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, state: "closed" }));
    const page2 = [{ number: 99, state: "open" }];
    expect(openNumbers([page1, page2])).toEqual([99]);
  });
});

describe("ticketReadyReport", () => {
  it("exits 0 and logs when the ticket is ready", () => {
    expect(ticketReadyReport("faultforge", 47, { title: "A thing", problems: [] })).toEqual({
      code: 0,
      stream: "log",
      message: "faultforge #47 is ready: A thing",
    });
  });

  it("exits 1 and logs the problems when the ticket is not ready, never the code gh failures use", () => {
    const report = ticketReadyReport("faultforge", 47, { title: "A thing", problems: ["missing section"] });
    expect(report.code).toBe(1);
    expect(report.message).toContain("missing section");
  });

  it("exits 2 when gh could not be read, never the code a not-ready ticket uses", () => {
    const report = ticketReadyReport("faultforge", 47, { error: new Error("gh timed out") });
    expect(report).toEqual({
      code: 2,
      stream: "error",
      message: "faultforge #47: could not read the ticket: gh timed out",
    });
  });

  it("names a thrown non-Error the same way", () => {
    const report = ticketReadyReport("target", 4, { error: "boom" });
    expect(report.code).toBe(2);
    expect(report.message).toContain("boom");
  });
});
