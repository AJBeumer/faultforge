import { describe, expect, it } from "vitest";
import {
  type MeasureTicket,
  measureLine,
  measureRefusal,
  measureReport,
  summariseMeasure,
  ticketSetProblems,
} from "./clarify-measure.ts";
import type { ClarifyRun, Question } from "./factory-clarify.ts";

const GAP: MeasureTicket = { id: "codes-gap", text: "# Several at once", gapTerms: ["exit", "Code"] };
const COMPLETE: MeasureTicket = { id: "codes-complete", text: "# Several at once, in full" };
const question = (text: string, options = ["Yes", "No"]): Question => ({ question: text, options, recommended: 1 });
const asked = (...questions: Question[]): ClarifyRun => ({
  outcome: { kind: "questions", questions },
  costUsd: 0.5,
  turns: 4,
});
const SILENT: ClarifyRun = { outcome: { kind: "none" }, costUsd: 0.25, turns: 3 };
const FAILED: ClarifyRun = { outcome: { kind: "failed", reason: "no answer line" }, costUsd: null, turns: null };

describe("measureLine", () => {
  it("is a hit when a question about a gap ticket holds one of its terms, in any case", () => {
    const line = measureLine(GAP, asked(question("Which EXIT status when one fails?")));
    expect(line).toMatchObject({ id: "codes-gap", kind: "gap", outcome: "questions", right: true, costUsd: 0.5 });
  });

  it("finds a gap term in a question's options too", () => {
    expect(measureLine(GAP, asked(question("What should happen then?", ["Return code 1", "Carry on"]))).right).toBe(
      true,
    );
  });

  it("is a miss when the questions are about something else, or there are none", () => {
    expect(measureLine(GAP, asked(question("Should the output be sorted?"))).right).toBe(false);
    expect(measureLine(GAP, SILENT).right).toBe(false);
  });

  it("is right about a complete ticket only when it asks nothing", () => {
    expect(measureLine(COMPLETE, SILENT)).toMatchObject({ kind: "complete", right: true });
    expect(measureLine(COMPLETE, asked(question("Should the output be sorted?"))).right).toBe(false);
  });

  it("never counts a ticket it couldn't check as right, with or without a gap", () => {
    expect(measureLine(GAP, FAILED)).toMatchObject({ outcome: "failed", right: false });
    expect(measureLine(COMPLETE, FAILED)).toMatchObject({ outcome: "failed", right: false });
  });
});

describe("summariseMeasure and measureReport", () => {
  const lines = [
    measureLine(GAP, asked(question("Which exit status?"))),
    measureLine({ ...GAP, id: "other-gap" }, SILENT),
    measureLine(COMPLETE, SILENT),
    measureLine({ ...COMPLETE, id: "other-complete" }, asked(question("Sorted?"))),
    measureLine({ ...COMPLETE, id: "broken" }, FAILED),
  ];

  it("counts gaps asked about and complete tickets left alone, and failures apart from both", () => {
    expect(summariseMeasure(lines)).toEqual({
      gapTickets: 2,
      gapsAsked: 1,
      completeTickets: 2,
      completeSilent: 1,
      failed: 1,
      costUsd: 1.5,
    });
  });

  it("prints a line per ticket and the two rates", () => {
    const report = measureReport(lines).join("\n");
    expect(report).toContain("codes-gap  gap  asked about the gap");
    expect(report).toContain("other-gap  gap  MISSED the gap (0 other question(s))");
    expect(report).toContain("codes-complete  complete  no question, as it should be");
    expect(report).toContain("other-complete  complete  asked 1 question(s) of a complete ticket");
    expect(report).toContain("broken  complete  could not be checked");
    expect(report).toContain("Tickets with a gap: asked about it in 1 of 2");
    expect(report).toContain("Complete tickets: no question in 1 of 2");
    expect(report).toContain("Could not be checked: 1");
  });
});

describe("ticketSetProblems", () => {
  it("accepts a set of tickets with ids, texts and optional gap terms", () => {
    expect(ticketSetProblems([GAP, COMPLETE])).toEqual([]);
  });

  it("refuses a set that isn't a list, an entry without an id or a text, a repeated id, or terms that aren't words", () => {
    expect(ticketSetProblems({})).toHaveLength(1);
    expect(ticketSetProblems([])).toHaveLength(1);
    expect(ticketSetProblems([{ id: "a" }])).toEqual(["ticket 1 needs an id and a text"]);
    expect(ticketSetProblems([null])).toEqual(["ticket 1 needs an id and a text"]);
    expect(ticketSetProblems([GAP, GAP])).toEqual(["ticket id codes-gap is used twice"]);
    expect(ticketSetProblems([{ ...GAP, gapTerms: ["", 3] }])).toEqual([
      "ticket codes-gap: its gap terms must be a list of words",
    ]);
  });
});

describe("measureRefusal", () => {
  it("refuses to run in CI, where its agent would start without the factory's sandbox, and runs elsewhere", () => {
    expect(measureRefusal({ CI: "true" })).toMatch(/owner's machine only/);
    expect(measureRefusal({ GITHUB_ACTIONS: "true" })).toMatch(/owner's machine only/);
    expect(measureRefusal({})).toBeUndefined();
    expect(measureRefusal({ CI: "" })).toBeUndefined();
  });
});
