import { describe, expect, it } from "vitest";
import { loadFactory, type QualityGate, STRICTEST_GATE } from "./factory-config.ts";
import { findingTitle, gateAccount, gateReport, gateText } from "./quality-gate.ts";

const GATE: QualityGate = {
  fix: ["action_required", "remediation_recommended"],
  flag: ["informational"],
  maxRounds: 3,
};
const HEAD = "a".repeat(40);
const record = (openFindings: unknown, extra: object = {}) => ({
  headSha: HEAD,
  state: "complete",
  openFindings,
  ...extra,
});

describe("gateAccount", () => {
  it("is met with nothing open", () => {
    const account = gateAccount(record([]), GATE, { head: HEAD, requireComplete: true });
    expect(account).toEqual({ met: true, mustFix: [], unknown: [], flagged: [], problems: [] });
  });

  it("blocks on an open remediation-recommended finding, not only an action-required one", () => {
    const account = gateAccount(record([{ severity: "remediation_recommended", title: "Lost update" }]), GATE);
    expect(account.met).toBe(false);
    expect(account.problems).toEqual(["1 remediation_recommended (Medium) finding(s) still open: Lost update"]);
  });

  it("is met with only informational findings open, and lists each as flagged", () => {
    const low = [
      { severity: "informational", title: "Naming" },
      { severity: "informational", title: "Comment" },
    ];
    const account = gateAccount(record(low), GATE);
    expect(account.met).toBe(true);
    expect(account.flagged).toEqual(low);
    expect(gateReport(account, GATE).join("\n")).toContain("[informational (Low)] Naming");
  });

  it("blocks on a label it doesn't know and names the label", () => {
    const account = gateAccount(record([{ severity: "critical", title: "New kind" }]), GATE);
    expect(account.met).toBe(false);
    expect(account.unknown).toHaveLength(1);
    expect(account.problems[0]).toMatch(/label the gate doesn't know \(critical\): New kind/);
  });

  it("blocks on a finding with no label, or one that isn't an object", () => {
    for (const finding of [{ title: "No label" }, { severity: null }, { severity: 3 }, null, "text"]) {
      const account = gateAccount(record([finding]), GATE);
      expect(account.met).toBe(false);
      expect(account.problems[0]).toMatch(/\(none\)/);
    }
  });

  it("never reads a review of an older commit as a review of the head", () => {
    const account = gateAccount(record([], { headSha: "b".repeat(40) }), GATE, { head: HEAD });
    expect(account.met).toBe(false);
    expect(account.problems).toEqual(["the saved review is of bbbbbbb, not of aaaaaaa"]);
  });

  it("blocks when the record names no commit and a head was asked for", () => {
    const account = gateAccount({ state: "complete", openFindings: [] }, GATE, { head: HEAD });
    expect(account.problems).toEqual(["the saved review is of an unnamed commit, not of aaaaaaa"]);
  });

  it("blocks on a review that didn't finish, when asked to require it", () => {
    for (const state of ["review incomplete", "skipped by Qodo", "head moved during the review", undefined]) {
      const account = gateAccount(record([], { state }), GATE, { head: HEAD, requireComplete: true });
      expect(account.met).toBe(false);
      expect(account.problems).toEqual(["the saved review didn't finish, so its findings prove nothing"]);
    }
  });

  it("blocks when there is no record or no readable list of open findings", () => {
    expect(gateAccount(null, GATE).problems).toEqual(["there is no saved review to judge"]);
    expect(gateAccount(undefined, GATE).met).toBe(false);
    for (const open of [undefined, null, {}, "none"]) {
      const account = gateAccount(record(open), GATE);
      expect(account.met).toBe(false);
      expect(account.problems).toEqual(["the saved review has no readable list of open findings"]);
    }
  });

  it("counts each must-fix label on its own line, in the gate's order", () => {
    const account = gateAccount(
      record([
        { severity: "remediation_recommended", title: "B" },
        { severity: "action_required", title: "A" },
        { severity: "informational", title: "C" },
      ]),
      GATE,
    );
    expect(account.problems).toEqual([
      "1 action_required (High) finding(s) still open: A",
      "1 remediation_recommended (Medium) finding(s) still open: B",
    ]);
    expect(account.flagged).toHaveLength(1);
  });

  it("blocks on every open finding under the strictest gate", () => {
    const account = gateAccount(record([{ severity: "informational", title: "Low" }]), STRICTEST_GATE);
    expect(account.met).toBe(false);
  });
});

describe("findingTitle", () => {
  it("keeps a title to one bounded line that can't mention anyone, link or break a table", () => {
    const title = findingTitle({ title: "Ping @owner\n[link](http://x) `code` | <b>" + "x".repeat(300) });
    expect(title).not.toMatch(/[@`<>[\]()|\n]/);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(findingTitle({})).toBe("(untitled)");
    expect(findingTitle({ title: "   " })).toBe("(untitled)");
  });
});

describe("gateText", () => {
  it("names every label of the gate and its round limit, and nothing the gate doesn't hold", () => {
    const text = gateText({ fix: ["action_required"], flag: [], maxRounds: 2 });
    expect(text).toContain("labelled action_required (High),");
    expect(text).toContain("No label is exempt.");
    expect(text).toContain("At most 2 review rounds.");
    expect(text).not.toContain("remediation_recommended");
    expect(text).not.toContain("informational");
  });

  it("states the checked-in gate: fix High and Medium, flag Low, three rounds", () => {
    const gate = loadFactory().gate;
    expect(gate).toEqual(GATE);
    const text = gateText(gate as QualityGate);
    expect(text).toContain("labelled action_required (High) or remediation_recommended (Medium)");
    expect(text).toContain("Leave findings labelled informational (Low) unchanged");
    expect(text).toContain("At most 3 review rounds.");
    expect(text).toContain("only the owner settles a disagreement");
  });
});

describe("gateReport", () => {
  it("leads with the verdict and says none under an empty heading", () => {
    const lines = gateReport(gateAccount(record([]), GATE), GATE);
    expect(lines[0]).toBe("Quality gate: MET");
    expect(lines.filter((l) => l.endsWith(" none"))).toHaveLength(3);
    const not = gateReport(gateAccount(record([{ severity: "action_required", title: "A" }]), GATE), GATE);
    expect(not[0]).toBe("Quality gate: NOT MET");
    expect(not).toContain("  - [action_required (High)] A");
  });
});
