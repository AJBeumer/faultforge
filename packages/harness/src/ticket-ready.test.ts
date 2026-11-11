import { describe, expect, it } from "vitest";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { gitRepo } from "./fixtures/git-repo.ts";
import { checkTicket, openNumbers, readinessProblems, ticketReadyReport, writtenDependencies } from "./ticket-ready.ts";

/** A lab-like checkout at origin/main: the script and the helper the tickets below rely on. */
const LAB = gitRepo({
  "package.json": JSON.stringify({ scripts: { check: "vitest", "ticket:ready": "tsx x" } }),
  "packages/harness/src/factory-config.ts": "export function loadFactory() {}\n",
});
const noRefresh = () => {};

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

describe("stale premises (#147)", () => {
  const issue = (body: string) => JSON.stringify({ title: "A thing", body });
  const fakeGh =
    (body: string) =>
    (...args: string[]): string => {
      if (args.some((a) => a.endsWith("/blocked_by"))) return "[[]]";
      return issue(body);
    };

  it("appends stale premises after the other problems", () => {
    expect(readinessProblems(ready, SECTIONS.faultforge, [3], ["stale premise: src/gone.ts (path) not found"])).toEqual(
      ["blocked by open tickets #3", "stale premise: src/gone.ts (path) not found"],
    );
  });

  it("reports a ticket whose Notes name a file the checkout doesn't have", () => {
    const body = `${ready}\n\n### Notes\n- Extend \`packages/harness/src/no-such-file.ts\`; reuse \`loadFactory()\`.`;
    const result = checkTicket(factory, "faultforge", 1, fakeGh(body), () => LAB, noRefresh);
    expect(result.problems).toEqual([
      "stale premise: packages/harness/src/no-such-file.ts (path) not found on origin/main of the ticket's repo or 1 sibling repo",
    ]);
  });

  it("accepts a ticket whose premises all exist, and never checks its Done when", () => {
    const body = `### Result\nA \`packages/harness/src/new-thing.ts\`.\n\n### Done when\n- [ ] \`new:script\` runs \`newThing()\`\n\n### Must not break\n- \`npm run check\`\n\n### Notes\n- Reuse \`loadFactory()\` from \`packages/harness/src/factory-config.ts\` and \`ticket:ready\`.`;
    const result = checkTicket(factory, "faultforge", 1, fakeGh(body), () => LAB, noRefresh);
    expect(result.problems).toEqual([]);
  });

  it("throws when the checkout is missing, so the script exits 2 rather than reporting not ready", () => {
    expect(() => checkTicket(factory, "target", 1, fakeGh(ready), () => "/no/such/checkout", noRefresh)).toThrow(
      /checkout for target not found/,
    );
    expect(ticketReadyReport("target", 1, { error: new Error("checkout for target not found at x") }).code).toBe(2);
  });
  it("refreshes origin/main of the ticket's repo and every present sibling before reading (Qodo round 2)", () => {
    const refreshed: string[] = [];
    checkTicket(
      factory,
      "faultforge",
      1,
      fakeGh(ready),
      () => LAB,
      (dir) => {
        refreshed.push(dir);
      },
    );
    expect(refreshed).toEqual([LAB, LAB]);
  });

  it("throws when the refresh fails, so the script exits 2 rather than judging against an old main", () => {
    expect(() =>
      checkTicket(
        factory,
        "faultforge",
        1,
        fakeGh(ready),
        () => LAB,
        () => {
          throw new Error("fetch: could not resolve host");
        },
      ),
    ).toThrow(/could not resolve host/);
  });
});
