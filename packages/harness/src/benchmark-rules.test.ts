import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkOf, benchmarkProblems, changedLines, type RuleTemplate } from "./benchmark-rules.ts";
import { applyMutation, loadTemplate, type Template, templateRefusal } from "./inject-template.ts";
import { ROOT } from "./paths.ts";

const bug = (criteria: string[], benchmark?: number): RuleTemplate => ({
  id: "x-secret-v1",
  kind: "bug",
  invariantId: "INV-X-001",
  match: { kindTerms: ["off by one", "boundary"] },
  ticket: { criteria },
  ...(benchmark ? { benchmark } : {}),
});
const control = (id: string, criteria: string[], benchmark?: number): RuleTemplate => ({
  id,
  kind: "control",
  ticket: { criteria },
  ...(benchmark ? { benchmark } : {}),
});

describe("benchmarkProblems (#257)", () => {
  it("refuses a v2 bug template whose criteria restate its kind terms or invariant", () => {
    const problems = benchmarkProblems(
      bug(["A booking for the last night is accepted at the Boundary.", "Refers to INV-X-001."], 2),
      [control("c9", ["Something else."])],
    );
    expect(problems).toEqual([
      "ticket.criteria[0] restates what the change breaks (boundary)",
      "ticket.criteria[1] restates what the change breaks (INV-X-001)",
    ]);
  });

  it("leaves a v1 template alone, whatever its criteria say", () => {
    expect(benchmarkOf(bug([]))).toBe(1);
    expect(benchmarkProblems(bug(["At the boundary."]), [])).toEqual([]);
    expect(
      benchmarkProblems(control("c", ["All existing tests pass."]), [control("d", ["All existing tests pass."])]),
    ).toEqual([]);
  });

  it("refuses a criterion found in every control and no bug", () => {
    const others = [
      control("c1", ["All existing tests pass."]),
      control("c2", ["All existing tests pass."]),
      bug(["Existing tests continue to pass."]),
    ];
    expect(benchmarkProblems(control("c3", ["All existing tests pass."], 2), others)).toEqual([
      "ticket.criteria[0] appears only in controls, so its wording alone tells them apart",
    ]);
  });

  it("accepts a criterion shared by both kinds, and one no other template has", () => {
    const others = [control("c1", ["Existing tests pass."]), { ...bug(["Existing tests pass."]), id: "b2" }];
    expect(
      benchmarkProblems(control("c3", ["Existing tests pass.", "The docs say what cancel does."], 2), others),
    ).toEqual([]);
  });
});

describe("changedLines (#257, AUD-M7)", () => {
  const file = (lines: string[]) => `${lines.join("\n")}\n`;

  it("records only the line that changed inside a wider replaced block", () => {
    expect(changedLines(file(["a", "b", "c", "d", "e"]), file(["a", "b", "C", "d", "e"]))).toEqual([3, 3]);
  });

  it("records every added line", () => {
    expect(changedLines(file(["a", "b"]), file(["a", "x", "y", "b"]))).toEqual([2, 3]);
  });

  it("records a pure deletion as the line now standing where the removed lines were", () => {
    expect(changedLines(file(["a", "b", "c", "d"]), file(["a", "d"]))).toEqual([2, 2]);
    expect(changedLines(file(["a", "b", "c"]), file(["a", "b"]))).toEqual([2, 2]);
  });
});

describe("applyMutation and templateRefusal by benchmark version (#257)", () => {
  const base = {
    schemaVersion: 2,
    id: "x-secret-v1",
    kind: "bug",
    invariantId: "INV-X-001",
    defectClass: "off-by-one",
    summary: "s",
    file: "f.ts",
    find: "a\nb\nc\n",
    replace: "a\nB\nc\n",
    proofTest: "p.test.ts",
    match: { kindTerms: ["off by one"] },
    alsoBreaks: [],
    publish: { branch: "tidy-f", commitMessage: "Tidy f" },
    ticket: { title: "Tidy f", what: "Tidy it.", criteria: ["Existing tests still pass."] },
  } as unknown as Template;

  it("records the whole block for v1 and only the changed line for v2", () => {
    const run = (template: Template) => {
      const dir = mkdtempSync(join(tmpdir(), "mutation-"));
      writeFileSync(join(dir, "f.ts"), "start\na\nb\nc\nend\n");
      return applyMutation(dir, template);
    };
    expect(run(base)).toEqual([2, 4]);
    expect(run({ ...base, benchmark: 2 })).toEqual([3, 3]);
  });

  it("refuses a v2 template that breaks the rules, and accepts it as v1", () => {
    const telling = { ...base, ticket: { ...base.ticket, criteria: ["No off by one at the end."] } };
    expect(templateRefusal({ ...telling, benchmark: 2 }, "x-secret-v1", "dir")).toContain("benchmark v2 rules");
    expect(templateRefusal(telling, "x-secret-v1", "dir")).toBeUndefined();
  });

  it("still accepts every published template as it is", () => {
    const seed = join(ROOT, "templates", "seed");
    for (const id of readdirSync(seed)) {
      const template = loadTemplate(join(seed, id));
      expect(benchmarkOf(template)).toBe(1);
      expect(templateRefusal(template, id, join(seed, id))).toBeUndefined();
    }
    expect(
      JSON.parse(readFileSync(join(ROOT, "schemas", "template.v2.json"), "utf8")).properties.benchmark.enum,
    ).toEqual([1, 2]);
  });
});

describe("benchmarkProblems and changedLines: round two on PR 274", () => {
  const someone = control("c9", ["Something else."]);

  it("refuses a criterion naming a collateral invariant, and reads terms as whole words", () => {
    const t = { ...bug(["Mentions INV-Y-002."], 2), alsoBreaks: [{ invariantId: "INV-Y-002" }] };
    expect(benchmarkProblems(t, [someone])).toEqual(["ticket.criteria[0] restates what the change breaks (INV-Y-002)"]);
    const raceTerm = { ...bug(["The trace is kept."], 2), match: { kindTerms: ["race"] } };
    expect(benchmarkProblems(raceTerm, [someone])).toEqual([]);
  });

  it("refuses to judge a v2 template with no other template to compare its wording with", () => {
    expect(benchmarkProblems(control("c3", ["x"], 2), [])).toEqual([
      "no other template was given to compare its ticket wording with",
    ]);
  });

  it("records the last line when only its final newline changed", () => {
    expect(changedLines("a\nb", "a\nb\n")).toEqual([2, 2]);
    expect(changedLines("a\nb\n", "a\nb")).toEqual([2, 2]);
  });
});

describe("benchmarkProblems: kind terms as word starts, over the whole ticket", () => {
  const stem: RuleTemplate = {
    id: "x-stem-v1",
    kind: "bug",
    benchmark: 2,
    invariantId: "INV-X-009",
    match: { kindTerms: ["disclos", "race"] },
    ticket: { title: "Tidy the list", what: "Make it shorter.", criteria: ["Existing tests pass."] },
  };
  const others = [control("c1", ["Something else."])];

  it("finds a stem at the start of a longer word, as the match rule would", () => {
    const t = { ...stem, ticket: { ...stem.ticket, criteria: ["Nothing is disclosed to another user."] } };
    expect(benchmarkProblems(t, others)).toEqual(["ticket.criteria[0] restates what the change breaks (disclos)"]);
  });

  it("still never finds a term inside a word: race is not in trace", () => {
    const t = { ...stem, ticket: { ...stem.ticket, criteria: ["The trace keeps every step."] } };
    expect(benchmarkProblems(t, others)).toEqual([]);
  });

  it("reads the ticket's title and description too", () => {
    const t = { ...stem, ticket: { ...stem.ticket, title: "Stop a race on save", what: "Nothing disclosed." } };
    expect(benchmarkProblems(t, others)).toEqual([
      "ticket.title restates what the change breaks (race)",
      "ticket.what restates what the change breaks (disclos)",
    ]);
  });

  it("leaves a v1 template's ticket alone", () => {
    const t = { ...stem, benchmark: 1, ticket: { ...stem.ticket, title: "Stop a race" } };
    expect(benchmarkProblems(t, others)).toEqual([]);
  });
});
