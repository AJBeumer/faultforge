import { describe, expect, it } from "vitest";
import { formatFinding, type LocalReviewPayload, labelFindings, type RawFinding } from "./local-findings.ts";

const finding = (overrides: Partial<RawFinding> = {}): RawFinding => ({
  id: "f1",
  title: "A bug",
  description: "…",
  category: "Correctness",
  action_level: "action_required",
  diff_reference: { file_path: "src/a.ts", start_line: 10, end_line: 12 },
  ...overrides,
});

describe("labelFindings", () => {
  // `finding_state`'s lists hold full finding objects, not plain ids — confirmed live, 12 November,
  // on `review:local`'s own first real run against this repository.
  const f1 = finding({ id: "f1", title: "Replay exposes another user's data", category: "Security" });
  const f2 = finding({
    id: "f2",
    title: "Could use a shared helper",
    category: "Observability",
    action_level: "remediation_recommended",
    diff_reference: { file_path: "src/b.ts", start_line: 1, end_line: 1 },
  });
  const f3 = finding({ id: "f3", title: "Already fixed", category: "Correctness", diff_reference: null });

  const payload: LocalReviewPayload = {
    findings: [f1, f2, f3],
    finding_state: { complete: true, introduced: [f1], resolved: [f3], still_open: [f2], dismissed: [] },
  };

  it("labels a finding introduced by this run as new, everything else as carried over", () => {
    const findings = labelFindings(payload);
    expect(findings.find((f) => f.id === "f1")).toMatchObject({ label: "new", open: true });
    expect(findings.find((f) => f.id === "f2")).toMatchObject({ label: "carried over", open: true });
    expect(findings.find((f) => f.id === "f3")).toMatchObject({ label: "carried over", open: false });
  });

  it("reads the file and lines from the finding's diff_reference, null when there is none", () => {
    const findings = labelFindings(payload);
    expect(findings.find((f) => f.id === "f1")).toMatchObject({ file: "src/a.ts", lines: [10, 12] });
    expect(findings.find((f) => f.id === "f3")).toMatchObject({ file: null, lines: null });
  });

  it("is empty with no finding_state at all", () => {
    expect(labelFindings({ findings: [] })).toEqual([]);
  });
});

describe("formatFinding", () => {
  it("prints the file, lines, category, severity and label", () => {
    const line = formatFinding({
      id: "f1",
      file: "src/a.ts",
      lines: [10, 12],
      severity: "action_required",
      category: "Security",
      title: "A bug",
      description: null,
      label: "new",
      open: true,
    });
    expect(line).toBe("- [action_required] A bug (Security, src/a.ts:10-12) — new");
  });

  it("notes a closed finding", () => {
    const line = formatFinding({
      id: "f2",
      file: null,
      lines: null,
      severity: "remediation_recommended",
      category: "Correctness",
      title: "Fixed already",
      description: null,
      label: "carried over",
      open: false,
    });
    expect(line).toBe("- [remediation_recommended] Fixed already (Correctness, (no location)) — carried over, closed");
  });
});
