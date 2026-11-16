import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QualityGate } from "../shared/factory-config.ts";
import {
  firstLabelOnly,
  loadCases,
  publicCaseIds,
  type ReplayCase,
  replayCase,
  replayReport,
  summarise,
} from "./gate-replay.ts";

const SAVED: QualityGate = {
  fix: ["action_required", "remediation_recommended"],
  flag: ["informational"],
  maxRounds: 3,
};
const GATES = { "first label only": firstLabelOnly(SAVED), "saved gate": SAVED };

/** A made-up bug case: the planted change is in `src/a.ts`, lines 10 to 12, and its kind term is "leak". */
function bug(caseId: string, findings: ReplayCase["findings"]): ReplayCase {
  return {
    caseId,
    kind: "sabotage",
    config: "qodo-v9",
    injection: { file: "src/a.ts", lines: [10, 12] },
    kindTerms: ["leak"],
    findings,
  };
}
const control = (caseId: string, findings: ReplayCase["findings"] = []): ReplayCase => ({
  caseId,
  kind: "control",
  config: "qodo-v9",
  injection: null,
  kindTerms: [],
  findings,
});
/** A finding that describes the planted bug, with the given label. */
const catching = (id: string, severity: string | null) => ({
  id,
  file: "src/a.ts",
  lines: [10, 11] as [number, number],
  title: "A leak",
  severity,
});
/** A finding about something else in the same pull request. */
const other = (id: string, severity: string | null) => ({
  id,
  file: "src/b.ts",
  lines: [1, 2] as [number, number],
  title: "No test",
  severity,
});

describe("firstLabelOnly", () => {
  it("keeps the first label to fix and only flags the rest", () => {
    expect(firstLabelOnly(SAVED)).toEqual({
      fix: ["action_required"],
      flag: ["remediation_recommended", "informational"],
      maxRounds: 3,
    });
  });
});

describe("replayCase", () => {
  it("requires the fix under both gates when the catch is labelled action_required", () => {
    const line = replayCase(bug("FF-9001", [catching("f1", "action_required")]), GATES);
    expect(line.caught).toBe(true);
    expect(line.catchLabels).toEqual(["action_required"]);
    expect(line.outcomes["first label only"]?.bugBlocked).toBe(true);
    expect(line.outcomes["saved gate"]?.bugBlocked).toBe(true);
  });

  it("lets a caught bug pass under the first label only when the catch is labelled remediation_recommended", () => {
    const line = replayCase(bug("FF-9002", [catching("f1", "remediation_recommended")]), GATES);
    expect(line.caught).toBe(true);
    expect(line.outcomes["first label only"]).toEqual({ bugBlocked: false, otherBlocking: 0, flagged: 1, unknown: 0 });
    expect(line.outcomes["saved gate"]).toEqual({ bugBlocked: true, otherBlocking: 0, flagged: 0, unknown: 0 });
  });

  it("lets a caught bug pass under both gates when the catch is only informational", () => {
    const line = replayCase(bug("FF-9003", [catching("f1", "informational")]), GATES);
    expect(line.outcomes["saved gate"]).toEqual({ bugBlocked: false, otherBlocking: 0, flagged: 1, unknown: 0 });
  });

  it("reports a missed bug as missed, and counts what the gate would still make the agent act on", () => {
    const line = replayCase(bug("FF-9004", [other("f1", "remediation_recommended")]), GATES);
    expect(line.caught).toBe(false);
    expect(line.catchLabels).toEqual([]);
    expect(line.outcomes["saved gate"]).toEqual({ bugBlocked: false, otherBlocking: 1, flagged: 0, unknown: 0 });
    expect(line.outcomes["first label only"]?.otherBlocking).toBe(0);
  });

  it("counts a catch with an unknown or missing label as unknown: it blocks, and is never read as passing", () => {
    for (const label of ["high", null]) {
      const line = replayCase(bug("FF-9005", [catching("f1", label)]), GATES);
      expect(line.catchLabels).toEqual([label ?? "none"]);
      expect(line.outcomes["saved gate"]).toEqual({ bugBlocked: true, otherBlocking: 0, flagged: 0, unknown: 1 });
    }
  });

  it("counts every finding on a control as one the gate would force or flag", () => {
    const clean = replayCase(control("FF-9006"), GATES);
    expect(clean.outcomes["saved gate"]).toEqual({ bugBlocked: false, otherBlocking: 0, flagged: 0, unknown: 0 });
    const noisy = replayCase(
      control("FF-9007", [other("f1", "remediation_recommended"), other("f2", "informational")]),
      GATES,
    );
    expect(noisy.caught).toBe(false);
    expect(noisy.outcomes["saved gate"]).toEqual({ bugBlocked: false, otherBlocking: 1, flagged: 1, unknown: 0 });
    expect(noisy.outcomes["first label only"]).toEqual({ bugBlocked: false, otherBlocking: 0, flagged: 2, unknown: 0 });
  });
});

describe("summarise and replayReport", () => {
  const lines = [
    replayCase(bug("FF-9001", [catching("f1", "action_required")]), GATES),
    replayCase(
      bug("FF-9002", [catching("f1", "remediation_recommended"), other("f2", "remediation_recommended")]),
      GATES,
    ),
    replayCase(bug("FF-9004", [other("f1", "informational")]), GATES),
    replayCase(control("FF-9007", [other("f1", "remediation_recommended")]), GATES),
  ];

  it("totals what each gate would have decided", () => {
    expect(summarise(lines, "first label only")).toEqual({
      bugRuns: 3,
      caught: 2,
      caughtAndBlocked: 1,
      caughtButPassed: 1,
      controls: 1,
      forcedOnControls: 0,
      forcedOnBugRuns: 0,
      flagged: 4,
      unknown: 0,
    });
    expect(summarise(lines, "saved gate")).toMatchObject({
      caughtAndBlocked: 2,
      caughtButPassed: 0,
      forcedOnControls: 1,
      forcedOnBugRuns: 1,
      flagged: 1,
    });
  });

  it("prints one line per case, a block per gate, and what was not counted", () => {
    const report = replayReport(lines, GATES, ["FF-9008: no verdict yet"]).join("\n");
    expect(report).toMatch(
      /FF-9002 {2}\[qodo-v9\] {2}caught, labelled remediation_recommended \(Medium\).*PASSES WITH THE BUG/,
    );
    expect(report).toMatch(/FF-9004 {2}\[qodo-v9\] {2}missed by the reviewer/);
    expect(report).toMatch(/FF-9007 {2}\[qodo-v9\] {2}control/);
    // One configuration: one block, and no "together" block to repeat it.
    expect(report).toContain("configuration qodo-v9:");
    expect(report).not.toContain("every configuration together");
    expect(report).toContain("of those caught: fix required in 1; passes with the bug in 1");
    expect(report).toContain("Not counted:\n  FF-9008: no verdict yet");
  });

  it("gives each configuration its own block, then all together, and names a case with no configuration", () => {
    const mixed = [
      ...lines,
      { ...replayCase(bug("FF-9010", [catching("f1", "action_required")]), GATES), config: "qodo-v10" },
      { ...replayCase(control("FF-9011"), GATES), config: null },
    ];
    const report = replayReport(mixed, GATES, []);
    const titles = report.filter((l) => /^(configuration |every configuration)/.test(l));
    expect(titles).toEqual([
      "configuration not recorded:",
      "configuration qodo-v10:",
      "configuration qodo-v9:",
      "every configuration together:",
    ]);
    expect(report.join("\n")).toMatch(/FF-9011 {2}\[not recorded\] {2}control/);
  });
});

describe("publicCaseIds", () => {
  it("reads single ids and every id of a range, and nothing else", () => {
    const ids = publicCaseIds(["Cases FF-9002 to FF-9004 ran.", "See FF-9010 (and FF-90111, not an id)."]);
    expect([...ids].sort()).toEqual(["FF-9002", "FF-9003", "FF-9004", "FF-9010"]);
  });

  it("takes only the two ends of a range written backwards", () => {
    expect([...publicCaseIds(["FF-9004 to FF-9002"])].sort()).toEqual(["FF-9002", "FF-9004"]);
  });
});

describe("loadCases", () => {
  let root: string;
  /** The time of the made-up verdict numbered `i`. */
  const AT = (i: number) => `2026-11-13T18:0${i}:00.000Z`;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Private storage with one caught bug, one control, one unjudged case and one incomplete review. */
  function storage(): string {
    root = mkdtempSync(join(tmpdir(), "gate-replay-test-"));
    const priv = join(root, "private");
    mkdirSync(join(priv, "cases"), { recursive: true });
    mkdirSync(join(priv, "templates", "made-up-leak-v1"), { recursive: true });
    writeFileSync(
      join(priv, "templates", "made-up-leak-v1", "template.json"),
      JSON.stringify({ match: { kindTerms: ["leak"] } }),
    );
    const truth = [
      {
        caseId: "FF-9001",
        kind: "sabotage",
        templateId: "made-up-leak-v1",
        injectedFile: "src/a.ts",
        injectedLines: [10, 12],
      },
      { caseId: "FF-9002", kind: "control", templateId: "made-up-leak-v1" },
      {
        caseId: "FF-9003",
        kind: "sabotage",
        templateId: "made-up-leak-v1",
        injectedFile: "src/a.ts",
        injectedLines: [10, 12],
      },
      { caseId: "FF-9004", kind: "control", templateId: "made-up-leak-v1" },
      { caseId: "FF-9005", kind: "control", templateId: "made-up-leak-v1" },
      { caseId: "FF-9006", kind: "control", templateId: "made-up-leak-v1" },
    ];
    writeFileSync(join(priv, "ground-truth.jsonl"), `${truth.map((t) => JSON.stringify(t)).join("\n")}\n`);
    // FF-9005 has a verdict and no saved record. FF-9006 was judged twice, and its record holds the first verdict.
    const events = ["FF-9001", "FF-9002", "FF-9004", "FF-9005", "FF-9006", "FF-9006"].map((caseId, i) => ({
      eventId: `e${i}`,
      type: "case.adjudicated",
      caseId,
      at: AT(i),
    }));
    writeFileSync(join(priv, "audit-events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    const save = (id: string, record: object) =>
      writeFileSync(join(priv, "cases", `${id}.json`), JSON.stringify(record));
    const judged = (i: number) => ({ human: { adjudicatedAt: AT(i) } });
    save("FF-9001", {
      status: "complete",
      review: { configVersion: "qodo-v9" },
      findings: [catching("f1", "remediation_recommended")],
      ...judged(0),
    });
    save("FF-9002", { status: "complete", findings: [], ...judged(1) });
    save("FF-9003", { status: "complete", findings: [] });
    save("FF-9004", { status: "incomplete", findings: [], ...judged(2) });
    save("FF-9006", { status: "complete", findings: [], ...judged(4) });
    writeFileSync(join(priv, "cases", "FF-9001.overlay.json"), "{}");
    return priv;
  }

  it("counts judged cases with a complete review and lists the rest as not counted", () => {
    const priv = storage();
    const { cases, skipped } = loadCases(priv, null, { FAULTFORGE_PRIVATE_DIR: priv });
    expect(cases.map((c) => [c.caseId, c.kind])).toEqual([
      ["FF-9001", "sabotage"],
      ["FF-9002", "control"],
    ]);
    expect(cases[0]?.kindTerms).toEqual(["leak"]);
    expect(cases.map((c) => c.config)).toEqual(["qodo-v9", null]);
    expect(skipped).toEqual([
      "FF-9003: no verdict yet",
      "FF-9004: its review is incomplete",
      "FF-9005: it has a verdict but no saved record; build one with case:build",
      "FF-9006: its saved record doesn't hold its latest verdict; build it again with case:build",
    ]);
  });

  /** Appends one verdict event to the made-up audit log. */
  const appendVerdict = (priv: string, eventId: string, caseId: string, at: unknown) =>
    appendFileSync(
      join(priv, "audit-events.jsonl"),
      `${JSON.stringify({ eventId, type: "case.adjudicated", caseId, at })}\n`,
    );

  it("takes the latest verdict by its time, as case:build does, when the log holds them out of order", () => {
    const priv = storage();
    // An older verdict for FF-9002 written to the log after the one its record was built from.
    appendVerdict(priv, "late-line", "FF-9002", "2026-11-13T17:00:00.000Z");
    const { cases, skipped } = loadCases(priv, null, { FAULTFORGE_PRIVATE_DIR: priv });
    expect(cases.map((c) => c.caseId)).toContain("FF-9002");
    expect(skipped.join("\n")).not.toContain("FF-9002");
  });

  it("stops when a verdict has no readable time, and never prints totals that lack the case", () => {
    for (const at of ["not a time", undefined, 5]) {
      const priv = storage();
      appendVerdict(priv, "unreadable", "FF-9002", at);
      expect(() => loadCases(priv, null, { FAULTFORGE_PRIVATE_DIR: priv })).toThrow(
        /FF-9002: a verdict in the audit log has no readable time/,
      );
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("with a public list, never names a case outside it, even when that case's verdict can't be read", () => {
    const priv = storage();
    appendVerdict(priv, "unreadable", "FF-9001", "not a time");
    const { cases, skipped } = loadCases(priv, new Set(["FF-9002"]), { FAULTFORGE_PRIVATE_DIR: priv });
    expect(cases.map((c) => c.caseId)).toEqual(["FF-9002"]);
    expect(skipped.join("\n")).not.toContain("FF-9001");
  });

  it("with a public list, says nothing at all about a case outside it", () => {
    const priv = storage();
    const { cases, skipped } = loadCases(priv, new Set(["FF-9002"]), { FAULTFORGE_PRIVATE_DIR: priv });
    expect(cases.map((c) => c.caseId)).toEqual(["FF-9002"]);
    expect(skipped).toEqual([]);
  });

  it("stops, and never counts a case as passing, when a record has no findings list", () => {
    const priv = storage();
    writeFileSync(
      join(priv, "cases", "FF-9001.json"),
      JSON.stringify({ status: "complete", human: { adjudicatedAt: AT(0) } }),
    );
    expect(() => loadCases(priv, null, { FAULTFORGE_PRIVATE_DIR: priv })).toThrow(
      /FF-9001: the case record has no list/,
    );
  });
});
