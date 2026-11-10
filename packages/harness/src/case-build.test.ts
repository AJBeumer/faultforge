import { describe, expect, it } from "vitest";
import {
  type BuildInputs,
  buildCaseRecord,
  type Overlay,
  overlayFieldsTaken,
  overlayProblems,
  parseCliArgs,
  printRecord,
  repoSlug,
} from "./case-build.ts";
import { validateCaseRecord } from "./case-record.ts";
import type { LedgerEntry } from "./ledger.ts";
import type { Finding } from "./review-wait.ts";

const ENTRY: LedgerEntry = {
  caseId: "FF-0002",
  kind: "sabotage",
  templateId: "a-template",
  invariantId: "INV-X-001",
  defectClass: "off-by-one",
  targetRepo: "https://github.com/AJBeumer/faultforge-target.git",
  targetCommit: "a".repeat(40),
  injectionCommit: "b".repeat(40),
  injectedFile: "src/x.ts",
  injectedLines: [10, 12],
  amendments: [],
};

function event(type: string, fields: Record<string, unknown> = {}): LedgerEntry {
  return { eventId: `${type}-id`, type, caseId: "FF-0002", at: "2026-11-05T00:00:00.000Z", amendments: [], ...fields };
}

const REVIEW_EVENT = event("review.recorded", {
  pr: { repo: "AJBeumer/faultforge-target", number: 9, url: "https://github.com/AJBeumer/faultforge-target/pull/9" },
  review: {
    reviewer: "qodo-code-review[bot]",
    path: "pr-comments",
    configVersion: "v3",
    reviewedCommit: "b".repeat(40),
    reviewedAt: "2026-11-05T00:05:00.000Z",
    url: "https://github.com/AJBeumer/faultforge-target/pull/9#issuecomment-1",
  },
});

const ADJUDICATED_EVENT = event("case.adjudicated", {
  disposition: "confirmed_detected",
  by: "AJBeumer",
  at: "2026-11-05T00:10:00.000Z",
});

const EVENTS: LedgerEntry[] = [event("sabotage.injected"), REVIEW_EVENT, ADJUDICATED_EVENT];

const FINDING: Finding = {
  id: "f1",
  file: "src/x.ts",
  lines: [10, 12],
  severity: "action_required",
  category: "Bug",
  title: "An off-by-one",
  description: "Loops one too many times, off by one.",
};

const OVERLAY: Overlay = {
  challenge: { verdict: "not_run", note: "not run yet" },
};

function inputs(extra: Partial<BuildInputs> = {}): BuildInputs {
  return { entry: ENTRY, events: EVENTS, findings: [FINDING], overlay: OVERLAY, kindTerms: ["off by one"], ...extra };
}

describe("buildCaseRecord", () => {
  it("builds a valid record field by field", () => {
    const record = buildCaseRecord(inputs());
    expect(record).toMatchObject({
      schemaVersion: 1,
      caseId: "FF-0002",
      kind: "sabotage",
      target: { repo: "AJBeumer/faultforge-target", baseCommit: "a".repeat(40) },
      injection: {
        templateId: "a-template",
        invariantId: "INV-X-001",
        defectClass: "off-by-one",
        file: "src/x.ts",
        lines: [10, 12],
        commit: "b".repeat(40),
      },
      pr: {
        repo: "AJBeumer/faultforge-target",
        number: 9,
        url: "https://github.com/AJBeumer/faultforge-target/pull/9",
      },
      review: {
        reviewer: "qodo-code-review[bot]",
        path: "pr-comments",
        configVersion: "v3",
        reviewedCommit: "b".repeat(40),
        reviewedAt: "2026-11-05T00:05:00.000Z",
        url: "https://github.com/AJBeumer/faultforge-target/pull/9#issuecomment-1",
      },
      findings: [
        {
          id: "qodo:f1",
          title: "An off-by-one",
          file: "src/x.ts",
          lines: [10, 12],
          category: "Bug",
          severity: "action_required",
          summary: "Loops one too many times, off by one.",
        },
      ],
      detection: { caught: true, matchedFindingIds: ["qodo:f1"] },
      human: {
        disposition: "confirmed_detected",
        adjudicatedBy: "AJBeumer",
        adjudicatedAt: "2026-11-05T00:10:00.000Z",
      },
      status: "complete",
    });
    expect(validateCaseRecord(record)).toEqual([]);
  });

  it("refuses a case missing the injection stage, naming it", () => {
    expect(() => buildCaseRecord(inputs({ events: [REVIEW_EVENT, ADJUDICATED_EVENT] }))).toThrow(/injection stage/);
  });

  it("refuses a case missing the review stage, naming it", () => {
    expect(() => buildCaseRecord(inputs({ events: [event("sabotage.injected"), ADJUDICATED_EVENT] }))).toThrow(
      /review stage/,
    );
  });

  it("refuses a case missing the adjudication stage, naming it", () => {
    expect(() => buildCaseRecord(inputs({ events: [event("sabotage.injected"), REVIEW_EVENT] }))).toThrow(
      /adjudication stage/,
    );
  });

  it("misses when no finding matches the injected file and lines", () => {
    const record = buildCaseRecord(inputs({ findings: [{ ...FINDING, file: "src/other.ts" }] })) as {
      detection: { caught: boolean; matchedFindingIds: string[] };
    };
    expect(record.detection.caught).toBe(false);
    expect(record.detection.matchedFindingIds).toEqual([]);
  });

  it("marks status incomplete when the review was never finished", () => {
    const record = buildCaseRecord(
      inputs({
        events: [
          event("sabotage.injected"),
          REVIEW_EVENT,
          event("case.adjudicated", {
            disposition: "review_incomplete",
            by: "AJBeumer",
            at: "2026-11-05T00:10:00.000Z",
          }),
        ],
      }),
    ) as { status: string };
    expect(record.status).toBe("incomplete");
  });

  it("applies a detection.matchDetailOverrides entry to the detail only, never the pass", () => {
    const record = buildCaseRecord(
      inputs({ overlay: { ...OVERLAY, detection: { matchDetailOverrides: { kind: "custom wording" } } } }),
    ) as { detection: { match: { kind: { pass: boolean; detail: string } } } };
    expect(record.detection.match.kind).toEqual({ pass: true, detail: "custom wording" });
  });

  it("applies per-finding severity, commentLines and summary overrides", () => {
    const record = buildCaseRecord(
      inputs({
        overlay: { ...OVERLAY, findings: [{ id: "f1", severity: "high", commentLines: [1, 5], summary: "edited" }] },
      }),
    ) as { findings: { severity: string; commentLines: [number, number]; summary: string }[] };
    expect(record.findings[0]).toMatchObject({ severity: "high", commentLines: [1, 5], summary: "edited" });
  });

  it("uses the most recent case.adjudicated event when the verdict was corrected", () => {
    const firstVerdict = event("case.adjudicated", {
      disposition: "review_incomplete",
      by: "AJBeumer",
      at: "2026-11-05T00:09:00.000Z",
    });
    const record = buildCaseRecord(
      inputs({ events: [event("sabotage.injected"), REVIEW_EVENT, firstVerdict, ADJUDICATED_EVENT] }),
    ) as { human: { disposition: string } };
    expect(record.human.disposition).toBe("confirmed_detected");
  });

  it("refuses a review recorded for a different commit than the injection", () => {
    const mismatched = event("review.recorded", {
      pr: REVIEW_EVENT.pr,
      review: { ...(REVIEW_EVENT.review as object), reviewedCommit: "c".repeat(40) },
    });
    expect(() =>
      buildCaseRecord(inputs({ events: [event("sabotage.injected"), mismatched, ADJUDICATED_EVENT] })),
    ).toThrow(/not the injected commit/);
  });

  it("refuses an adjudication recorded for a different commit than the review", () => {
    const mismatched = event("case.adjudicated", { ...ADJUDICATED_EVENT, commit: "c".repeat(40) });
    expect(() => buildCaseRecord(inputs({ events: [event("sabotage.injected"), REVIEW_EVENT, mismatched] }))).toThrow(
      /not the reviewed commit/,
    );
  });

  it("refuses a review.recorded event with no reviewer or path, instead of defaulting", () => {
    const bare = event("review.recorded", {
      pr: REVIEW_EVENT.pr,
      review: { configVersion: "v3", reviewedCommit: "b".repeat(40), reviewedAt: "2026-11-05T00:05:00.000Z", url: "u" },
    });
    expect(() => buildCaseRecord(inputs({ events: [event("sabotage.injected"), bare, ADJUDICATED_EVENT] }))).toThrow(
      /reviewer/,
    );
  });

  it("leaves out injection, detection, collateral for a control case", () => {
    const controlEntry: LedgerEntry = { ...ENTRY, kind: "control" };
    const record = buildCaseRecord(
      inputs({ entry: controlEntry, findings: [], overlay: { challenge: OVERLAY.challenge } }),
    );
    expect(record).not.toHaveProperty("injection");
    expect(record).not.toHaveProperty("detection");
  });
});

describe("repoSlug", () => {
  it("strips the host and the .git suffix", () => {
    expect(repoSlug("https://github.com/AJBeumer/faultforge-target.git")).toBe("AJBeumer/faultforge-target");
  });
});

describe("overlayProblems", () => {
  it("accepts the documented fields", () => {
    expect(
      overlayProblems({
        detection: { notes: ["a"] },
        collateral: [],
        otherReviewers: [],
        challenge: { verdict: "not_run", note: "n" },
        review: { linkedRepositories: "none" },
      }),
    ).toEqual([]);
  });

  it("rejects an unknown top-level field, naming it", () => {
    expect(overlayProblems({ sneaky: true })).toEqual(["overlay sets sneaky, which is not allowed"]);
  });

  it("rejects an unknown detection field, naming it", () => {
    expect(overlayProblems({ detection: { caught: true } })).toEqual([
      "overlay sets detection.caught, which is not allowed",
    ]);
  });

  it("rejects an unknown review field, naming it", () => {
    expect(overlayProblems({ review: { reviewer: "someone else" } })).toEqual([
      "overlay sets review.reviewer, which is not allowed",
    ]);
  });

  it("rejects the legacy-only extras for a case with a saved review", () => {
    expect(overlayProblems({ findings: [{ id: "f1", severity: "high" }] }, false)).toEqual([
      "overlay sets findings, which only a case with no saved review may use",
    ]);
    expect(overlayProblems({ legacyFindingsPath: "x.json" }, false)).toEqual([
      "overlay sets legacyFindingsPath, which only a case with no saved review may use",
    ]);
    expect(overlayProblems({ detection: { matchDetailOverrides: { kind: "x" } } }, false)).toEqual([
      "overlay sets detection.matchDetailOverrides, which is not allowed",
    ]);
  });

  it("accepts the legacy-only extras for a case with no saved review", () => {
    expect(
      overlayProblems(
        {
          detection: { matchDetailOverrides: { kind: "x" } },
          findings: [{ id: "f1", severity: "high", commentLines: [1, 2], summary: "s" }],
          legacyFindingsPath: "private/raw-artifacts/x.json",
        },
        true,
      ),
    ).toEqual([]);
  });

  it("rejects an unknown findings override field, naming it", () => {
    expect(overlayProblems({ findings: [{ id: "f1", file: "x" }] }, true)).toEqual([
      "overlay sets findings[].file, which is not allowed",
    ]);
  });

  it("reports a malformed findings shape as a problem, not a crash", () => {
    expect(overlayProblems({ findings: {} }, true)).toEqual(["overlay sets findings, which must be an array"]);
    expect(overlayProblems({ findings: [null] }, true)).toEqual([
      "overlay sets a findings[] entry that isn't an object",
    ]);
  });
});

describe("overlayFieldsTaken", () => {
  it("lists only the fields actually present", () => {
    expect(overlayFieldsTaken({ challenge: { verdict: "not_run", note: "n" } })).toEqual(["challenge"]);
  });

  it("lists nothing for an empty overlay", () => {
    expect(overlayFieldsTaken({})).toEqual([]);
  });
});

describe("printRecord", () => {
  it("inlines a short array of scalars", () => {
    expect(printRecord({ lines: [33, 33] })).toBe('{\n  "lines": [33, 33]\n}');
  });

  it("inlines a short { pass, detail } criterion", () => {
    expect(printRecord({ pass: true, detail: "ok" })).toBe('{ "pass": true, "detail": "ok" }');
  });

  it("breaks a { pass, detail } criterion that doesn't fit the line width", () => {
    const long = "x".repeat(200);
    expect(printRecord({ pass: true, detail: long })).toBe(`{\n  "pass": true,\n  "detail": "${long}"\n}`);
  });

  it("always expands an object that isn't a criterion, even when short", () => {
    expect(printRecord({ a: 1, b: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("always expands an array of objects", () => {
    expect(printRecord([{ a: 1 }])).toBe('[\n  {\n    "a": 1\n  }\n]');
  });
});

describe("parseCliArgs", () => {
  it("parses a bare case id", () => {
    expect(parseCliArgs(["FF-0002"])).toEqual({ caseId: "FF-0002", write: false });
  });

  it("parses --write", () => {
    expect(parseCliArgs(["FF-0002", "--write"])).toEqual({ caseId: "FF-0002", write: true });
  });

  it("rejects no arguments", () => {
    expect(parseCliArgs([])).toBeNull();
  });
});
