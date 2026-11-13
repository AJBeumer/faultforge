import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  run,
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

  it("rejects detection or review that isn't an object, instead of ignoring it", () => {
    expect(overlayProblems({ detection: [] })).toEqual(["overlay sets detection, which must be an object"]);
    expect(overlayProblems({ detection: null })).toEqual(["overlay sets detection, which must be an object"]);
    expect(overlayProblems({ review: "none" })).toEqual(["overlay sets review, which must be an object"]);
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

describe("run: legacy path only applies with no genuine saved review", () => {
  const CASE_ID = "FF-9001";
  const INJECTION_COMMIT = "d".repeat(40);
  // overlay.legacyFindingsPath is read relative to the repo root (it names a path like
  // "private/raw-artifacts/<case>/..."), so the fixture's own file is named relative to it too.
  const REPO_ROOT = join(import.meta.dirname, "../../..");

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "case-build-"));
    const groundTruthPath = join(root, "ground-truth.jsonl");
    const auditEventsPath = join(root, "audit-events.jsonl");
    const overlayPath = join(root, `${CASE_ID}.overlay.json`);
    const examplesDir = join(root, "examples");
    mkdirSync(examplesDir, { recursive: true });
    mkdirSync(join(root, "templates", "t1"), { recursive: true });
    writeFileSync(
      join(root, "templates", "t1", "template.json"),
      JSON.stringify({ match: { kindTerms: ["off by one"] } }),
    );

    const entry = {
      caseId: CASE_ID,
      kind: "sabotage",
      templateId: "t1",
      invariantId: "INV-1",
      defectClass: "off-by-one",
      targetRepo: "https://github.com/Owner/target.git",
      targetCommit: "a".repeat(40),
      injectionCommit: INJECTION_COMMIT,
      injectedFile: "src/x.ts",
      injectedLines: [1, 2],
    };
    writeFileSync(groundTruthPath, `${JSON.stringify(entry)}\n`);

    const events = [
      { eventId: "e1", type: "sabotage.injected", caseId: CASE_ID, at: "2026-11-01T00:00:00.000Z" },
      {
        eventId: "e2",
        type: "review.recorded",
        caseId: CASE_ID,
        at: "2026-11-01T00:05:00.000Z",
        pr: { repo: "Owner/target", number: 5, url: "https://github.com/Owner/target/pull/5" },
        review: {
          reviewer: "qodo-code-review[bot]",
          path: "pr-comments",
          configVersion: "v1",
          reviewedCommit: INJECTION_COMMIT,
          reviewedAt: "2026-11-01T00:05:00.000Z",
          url: "https://github.com/Owner/target/pull/5#issuecomment-1",
        },
      },
      {
        eventId: "e3",
        type: "case.adjudicated",
        caseId: CASE_ID,
        at: "2026-11-01T00:10:00.000Z",
        disposition: "confirmed_detected",
        by: "Owner",
      },
    ];
    writeFileSync(auditEventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    return { root, groundTruthPath, auditEventsPath, overlayPath, examplesDir };
  }

  async function runOn(fx: ReturnType<typeof fixture>, overlay: Record<string, unknown>) {
    writeFileSync(fx.overlayPath, JSON.stringify(overlay));
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(CASE_ID, {
      env: { FAULTFORGE_PRIVATE_DIR: fx.root },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      groundTruthPath: fx.groundTruthPath,
      auditEventsPath: fx.auditEventsPath,
      reviewsDir: join(fx.root, "raw-artifacts", "reviews"),
      overlayPath: fx.overlayPath,
      examplesDir: fx.examplesDir,
    });
    return { out, err, code };
  }

  it("prefers a genuine saved review over an overlay's legacyFindingsPath, even with null pushSeenAt/reviewStartedAt", async () => {
    const fx = fixture();
    const reviewDir = join(fx.root, "raw-artifacts", "reviews", "target-pr5");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, `${INJECTION_COMMIT.slice(0, 7)}.review.json`),
      JSON.stringify({
        repo: "Owner/target",
        pr: 5,
        headSha: INJECTION_COMMIT,
        state: "complete",
        // review:wait can genuinely write null for both (no check suite found, no started_at reported).
        pushSeenAt: null,
        reviewStartedAt: null,
        reviewSeenCompleteAt: "2026-11-01T00:05:00.000Z",
        findings: [
          {
            id: "f1",
            file: "src/x.ts",
            lines: [1, 2],
            severity: "action_required",
            category: "Bug",
            title: "An off-by-one",
            description: "loops off by one",
          },
        ],
      }),
    );
    writeFileSync(
      join(fx.root, "legacy-findings.json"),
      JSON.stringify({
        findings: [{ id: "wrong", git_sha: INJECTION_COMMIT, file_path: "src/x.ts", start_line: 1, end_line: 2 }],
      }),
    );
    const { code, out } = await runOn(fx, {
      challenge: { verdict: "not_run", note: "n" },
      legacyFindingsPath: relative(REPO_ROOT, join(fx.root, "legacy-findings.json")),
    });
    // The overlay sets legacyFindingsPath even though a genuine saved review exists: refused, since
    // that extra is reserved for a case with no saved review.
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/only a case with no saved review may use/);
  });

  it("falls back to the overlay's legacy path when the saved review isn't a genuine review:wait save", async () => {
    const fx = fixture();
    const reviewDir = join(fx.root, "raw-artifacts", "reviews", "target-pr5");
    mkdirSync(reviewDir, { recursive: true });
    // Missing pushSeenAt/reviewStartedAt/reviewSeenCompleteAt: hand-backfilled, not review:wait's own.
    writeFileSync(
      join(reviewDir, `${INJECTION_COMMIT.slice(0, 7)}.review.json`),
      JSON.stringify({ repo: "Owner/target", pr: 5, headSha: INJECTION_COMMIT, state: "complete", findings: [] }),
    );
    writeFileSync(
      join(fx.root, "legacy-findings.json"),
      JSON.stringify({
        findings: [
          {
            id: "legacy-1",
            git_sha: INJECTION_COMMIT,
            file_path: "src/x.ts",
            start_line: 1,
            end_line: 2,
            category: "Bug",
            title: "An off-by-one",
            description: "loops off by one",
          },
        ],
      }),
    );
    const { code, out } = await runOn(fx, {
      challenge: { verdict: "not_run", note: "n" },
      legacyFindingsPath: relative(REPO_ROOT, join(fx.root, "legacy-findings.json")),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("qodo:legacy-1");
  });

  it("builds an inconclusive record from a save of a review that never finished (#192)", async () => {
    const fx = fixture();
    writeFileSync(
      fx.auditEventsPath,
      readFileSync(fx.auditEventsPath, "utf8").replace("confirmed_detected", "review_incomplete"),
    );
    const reviewDir = join(fx.root, "raw-artifacts", "reviews", "target-pr5");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, `${INJECTION_COMMIT.slice(0, 7)}.review.json`),
      JSON.stringify({
        repo: "Owner/target",
        pr: 5,
        headSha: INJECTION_COMMIT,
        state: "review incomplete",
        pushSeenAt: null,
        reviewStartedAt: null,
        reviewSeenCompleteAt: null,
        findings: [],
      }),
    );
    const { code, out, err } = await runOn(fx, { challenge: { verdict: "not_run", note: "n" } });
    expect(err.join("\n")).toBe("");
    expect(code).toBe(0);
    const text = out.join("\n");
    const record = JSON.parse(text.slice(text.indexOf("{")));
    expect(record).toMatchObject({ human: { disposition: "review_incomplete" }, status: "incomplete" });
  });

  it("refuses to build while the audit log has an amendment that changes a locked field (#192)", async () => {
    const fx = fixture();
    appendFileSync(
      fx.auditEventsPath,
      `${JSON.stringify({ kind: "amendment", amends: "e3", change: { at: "x" }, reason: "r", evidence: "e" })}\n`,
    );
    const { code, err } = await runOn(fx, { challenge: { verdict: "not_run", note: "n" } });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("changes at");
  });
});

describe("run: a control case (#162)", () => {
  const CASE_ID = "FF-9002";
  const COMMIT = "e".repeat(40);
  const CONTROL_TEMPLATE = {
    schemaVersion: 2,
    id: "c1",
    kind: "control",
    summary: "An ordinary, harmless change, used as a control case.",
    file: "src/x.ts",
    find: "a",
    replace: "b",
    publish: { branch: "tidy-x", commitMessage: "Tidy x" },
    ticket: { title: "Tidy x", what: "Tidy it.", criteria: ["Tests still pass."] },
  };

  /** Private storage for one control case, as inject, case:review and verdict leave it: no overlay. */
  function fixture(disposition: string | null, findings: unknown[] = []) {
    const root = mkdtempSync(join(tmpdir(), "case-build-control-"));
    const groundTruthPath = join(root, "ground-truth.jsonl");
    const auditEventsPath = join(root, "audit-events.jsonl");
    mkdirSync(join(root, "templates", "c1"), { recursive: true });
    writeFileSync(join(root, "templates", "c1", "template.json"), JSON.stringify(CONTROL_TEMPLATE));
    const entry = {
      caseId: CASE_ID,
      kind: "control",
      templateId: "c1",
      targetRepo: "https://github.com/Owner/target.git",
      targetCommit: "a".repeat(40),
      injectionCommit: COMMIT,
      injectedFile: "src/x.ts",
      injectedLines: [1, 2],
    };
    writeFileSync(groundTruthPath, `${JSON.stringify(entry)}\n`);
    const events: Record<string, unknown>[] = [
      { eventId: "e1", type: "control.injected", caseId: CASE_ID, at: "2026-11-01T00:00:00.000Z" },
      {
        eventId: "e2",
        type: "review.recorded",
        caseId: CASE_ID,
        at: "2026-11-01T00:05:00.000Z",
        pr: { repo: "Owner/target", number: 6, url: "https://github.com/Owner/target/pull/6" },
        review: {
          reviewer: "qodo-code-review[bot]",
          path: "pr-comments",
          configVersion: "v1",
          reviewedCommit: COMMIT,
          reviewedAt: "2026-11-01T00:05:00.000Z",
          url: "https://github.com/Owner/target/pull/6#issuecomment-1",
        },
      },
    ];
    if (disposition) {
      events.push({
        eventId: "e3",
        type: "case.adjudicated",
        caseId: CASE_ID,
        at: "2026-11-01T00:10:00.000Z",
        disposition,
        by: "Owner",
      });
    }
    writeFileSync(auditEventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    const reviewDir = join(root, "raw-artifacts", "reviews", "target-pr6");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, `${COMMIT.slice(0, 7)}.review.json`),
      JSON.stringify({
        repo: "Owner/target",
        pr: 6,
        headSha: COMMIT,
        state: "complete",
        reviewSeenCompleteAt: null,
        findings,
      }),
    );
    return { root, groundTruthPath, auditEventsPath };
  }

  async function build(fx: ReturnType<typeof fixture>) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(CASE_ID, {
      env: { FAULTFORGE_PRIVATE_DIR: fx.root },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      groundTruthPath: fx.groundTruthPath,
      auditEventsPath: fx.auditEventsPath,
      reviewsDir: join(fx.root, "raw-artifacts", "reviews"),
      overlayPath: join(fx.root, "no-overlay.json"),
      examplesDir: join(fx.root, "examples"),
    });
    const text = out.join("\n");
    return { code, err: err.join("\n"), record: code === 0 ? JSON.parse(text.slice(text.indexOf("{"))) : null };
  }

  it("builds a clean control with no overlay as a version 1 record", async () => {
    const { code, err, record } = await build(fixture("confirmed_clean"));
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(record).toMatchObject({ schemaVersion: 1, kind: "control", human: { disposition: "confirmed_clean" } });
    expect(record).not.toHaveProperty("detection");
    expect(validateCaseRecord(record)).toEqual([]);
  });

  it.each([
    ["confirmed_false_alarm", "complete"],
    ["review_incomplete", "incomplete"],
  ])("builds a %s control as a version 2 record", async (disposition, status) => {
    const finding = { id: "f1", file: "src/x.ts", lines: [1, 1], category: "Bug", title: "t", description: "d" };
    const { code, err, record } = await build(fixture(disposition, [finding]));
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(record).toMatchObject({ schemaVersion: 2, human: { disposition }, status });
    expect(record.$schema).toBe("../schemas/case-record.v2.json");
    expect(validateCaseRecord(record)).toEqual([]);
  });

  it("refuses a control with no adjudication, naming the stage", async () => {
    const { code, err } = await build(fixture(null));
    expect(code).toBe(2);
    expect(err).toContain("the adjudication stage is missing");
  });
});
