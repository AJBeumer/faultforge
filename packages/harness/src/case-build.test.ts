import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs, run } from "./case-build.ts";
import { type BuildInputs, buildCaseRecord, type Overlay, repoSlug } from "./case-builder.ts";
import { overlayFieldsTaken, overlayProblems } from "./case-overlay.ts";
import { validateCaseRecord } from "./case-record.ts";
import { type LedgerEntry, readLedger } from "./ledger.ts";
import { verdictInputHash } from "./ledger-hashes.ts";
import { ROOT } from "./paths.ts";
import type { Finding } from "./qodo-review.ts";
import { printRecord } from "./record-print.ts";
import { isPublishedTemplate } from "./templates.ts";

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

  it("strips an ssh remote too, in both spellings (audit N-14)", () => {
    expect(repoSlug("git@github.com:AJBeumer/faultforge-target.git")).toBe("AJBeumer/faultforge-target");
    expect(repoSlug("ssh://git@github.com/AJBeumer/faultforge-target.git")).toBe("AJBeumer/faultforge-target");
    expect(repoSlug("https://github.com/AJBeumer/faultforge-target")).toBe("AJBeumer/faultforge-target");
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
    expect(overlayFieldsTaken({ notes: ["n"] })).toEqual(["notes"]);
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
    expect(parseCliArgs(["FF-0002"])).toEqual({ caseId: "FF-0002", write: false, save: false });
  });

  it("parses --write and --save", () => {
    expect(parseCliArgs(["FF-0002", "--write"])).toEqual({ caseId: "FF-0002", write: true, save: false });
    expect(parseCliArgs(["FF-0002", "--save"])).toEqual({ caseId: "FF-0002", write: false, save: true });
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

  it("refuses a bug case whose overlay sets notes: only a control may (Qodo on PR 222)", async () => {
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
        reviewSeenCompleteAt: null,
        findings: [],
      }),
    );
    const { code, err, out } = await runOn(fx, { notes: ["a note"] });
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("only a control may use");
    expect(out.join("\n")).not.toContain('"notes"');
  });

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
      JSON.stringify({
        repo: "Owner/target",
        pr: 5,
        headSha: INJECTION_COMMIT,
        state: "complete",
        findings: [],
      }),
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

  async function build(fx: ReturnType<typeof fixture>, overlay?: object) {
    const overlayPath = join(fx.root, overlay ? "overlay.json" : "no-overlay.json");
    if (overlay) writeFileSync(overlayPath, JSON.stringify(overlay));
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(CASE_ID, {
      env: { FAULTFORGE_PRIVATE_DIR: fx.root },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      groundTruthPath: fx.groundTruthPath,
      auditEventsPath: fx.auditEventsPath,
      reviewsDir: join(fx.root, "raw-artifacts", "reviews"),
      overlayPath,
      examplesDir: join(fx.root, "examples"),
    });
    const text = out.join("\n");
    return { code, err: err.join("\n"), record: code === 0 ? JSON.parse(text.slice(text.indexOf("{"))) : null };
  }

  it("builds a clean control with no overlay as a version 2 record, with what it changed from the answer key", async () => {
    const { code, err, record } = await build(fixture("confirmed_clean"));
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(record).toMatchObject({ schemaVersion: 2, kind: "control", human: { disposition: "confirmed_clean" } });
    expect(record.change).toEqual({ templateId: "c1", file: "src/x.ts", lines: [1, 2], commit: COMMIT });
    expect(record).not.toHaveProperty("injection");
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

  it("refuses a control whose change ends before it starts (Qodo on PR 222)", async () => {
    const { record } = await build(fixture("confirmed_clean"));
    expect(validateCaseRecord({ ...record, change: { ...record.change, lines: [10, 2] } })).toEqual([
      "change.lines 10-2 ends before it starts",
    ]);
  });

  it("links only a template inside templates/seed itself, not a folder whose name starts the same (Qodo on PR 222)", () => {
    const seed = join(ROOT, "templates", "seed");
    expect(isPublishedTemplate(join(seed, "c1"))).toBe(true);
    expect(isPublishedTemplate(join(`${seed}-private`, "c1"))).toBe(false);
    expect(isPublishedTemplate(seed)).toBe(false);
    expect(isPublishedTemplate(join(ROOT, "private", "templates", "c1"))).toBe(false);
  });

  it("takes a control's notes from its overlay", async () => {
    const { code, err, record } = await build(fixture("confirmed_clean"), { notes: ["Qodo raised nothing."] });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(record.notes).toEqual(["Qodo raised nothing."]);
    expect(validateCaseRecord(record)).toEqual([]);
  });

  it("refuses overlay notes that aren't a list of strings", () => {
    expect(overlayProblems({ notes: "one line" })).toEqual(["overlay sets notes, which must be a list of strings"]);
    expect(overlayProblems({ notes: ["fine"] })).toEqual([]);
  });

  it("the schema refuses a change block or notes on a bug case's record", async () => {
    const { record } = await build(fixture("confirmed_clean"));
    const { change, ...rest } = record;
    const bug = {
      ...rest,
      kind: "sabotage",
      injection: { ...change, invariantId: "INV-1", defectClass: "bug" },
      detection: { caught: false, matchedFindingIds: [], match: {} },
      human: { ...record.human, disposition: "confirmed_missed" },
    };
    const problems = (extra: object) => validateCaseRecord({ ...bug, ...extra }).join(" | ");
    expect(problems({ change })).toMatch(/must NOT be valid/);
    expect(problems({ notes: ["x"] })).toMatch(/must NOT be valid/);
  });

  it("refuses a control with no review event, naming the stage (Qodo on PR 214)", async () => {
    const fx = fixture("confirmed_clean");
    const lines = readFileSync(fx.auditEventsPath, "utf8").trim().split("\n");
    writeFileSync(fx.auditEventsPath, `${lines.filter((l) => !l.includes("review.recorded")).join("\n")}\n`);
    const { code, err } = await build(fx);
    expect(code).toBe(2);
    expect(err).toContain("the review stage is missing");
  });

  it("refuses a control with no adjudication, naming the stage", async () => {
    const { code, err } = await build(fixture(null));
    expect(code).toBe(2);
    expect(err).toContain("the adjudication stage is missing");
  });
});

describe("run: the record stands on the review the owner judged (AUD-M1, AUD-M26, #244)", () => {
  const CASE_ID = "FF-9003";
  const COMMIT = "c".repeat(40);
  const TEMPLATE_TEXT = JSON.stringify({ match: { kindTerms: ["off by one"] } });

  /** A bug case adjudicated by verdict (tool-written, with its inputHash) on a finished review of PR 7. */
  function fixture(opts: { state?: string; disposition?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "case-build-gate-"));
    const groundTruthPath = join(root, "ground-truth.jsonl");
    const auditEventsPath = join(root, "audit-events.jsonl");
    mkdirSync(join(root, "templates", "t9"), { recursive: true });
    writeFileSync(join(root, "templates", "t9", "template.json"), TEMPLATE_TEXT);
    const entry = {
      caseId: CASE_ID,
      kind: "sabotage",
      templateId: "t9",
      invariantId: "INV-1",
      defectClass: "off-by-one",
      targetRepo: "https://github.com/Owner/target.git",
      targetCommit: "a".repeat(40),
      injectionCommit: COMMIT,
      injectedFile: "src/x.ts",
      injectedLines: [1, 2],
    };
    writeFileSync(groundTruthPath, `${JSON.stringify(entry)}\n`);
    const reviewDir = join(root, "raw-artifacts", "reviews", "target-pr7");
    mkdirSync(reviewDir, { recursive: true });
    const savePath = join(reviewDir, `${COMMIT.slice(0, 7)}.review.json`);
    const saveText = JSON.stringify({
      repo: "Owner/target",
      pr: 7,
      headSha: COMMIT,
      state: opts.state ?? "complete",
      reviewSeenCompleteAt: "2026-11-01T00:04:00.000Z",
      findings: [],
    });
    writeFileSync(savePath, saveText);
    const read = readLedger(groundTruthPath)[0] as LedgerEntry;
    const events = [
      { eventId: "e0", type: "pr.opened", caseId: CASE_ID, at: "2026-11-01T00:01:00.000Z", pr: 7 },
      { eventId: "e1", type: "sabotage.injected", caseId: CASE_ID, at: "2026-11-01T00:00:00.000Z" },
      {
        eventId: "e2",
        type: "review.recorded",
        caseId: CASE_ID,
        at: "2026-11-01T00:05:00.000Z",
        pr: { repo: "Owner/target", number: 7, url: "https://github.com/Owner/target/pull/7" },
        review: {
          reviewer: "qodo-code-review[bot]",
          path: "pr-comments",
          configVersion: "v1",
          reviewedCommit: COMMIT,
          reviewedAt: "2026-11-01T00:05:00.000Z",
          url: "https://github.com/Owner/target/pull/7#issuecomment-1",
        },
      },
      {
        eventId: "e3",
        type: "case.adjudicated",
        caseId: CASE_ID,
        at: "2026-11-01T00:10:00.000Z",
        commit: COMMIT,
        by: "Owner",
        tool: "faultforge-harness@1.0.0",
        inputHash: verdictInputHash(read, TEMPLATE_TEXT, saveText),
        disposition: opts.disposition ?? "confirmed_missed",
        reason: "r",
        judgements: [],
      },
    ];
    writeFileSync(auditEventsPath, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    return { root, groundTruthPath, auditEventsPath, savePath, saveText };
  }

  async function build(fx: ReturnType<typeof fixture>, extra: { overlay?: object; save?: boolean } = {}) {
    const overlayPath = join(fx.root, extra.overlay ? "overlay.json" : "no-overlay.json");
    if (extra.overlay) writeFileSync(overlayPath, JSON.stringify(extra.overlay));
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(CASE_ID, {
      env: { FAULTFORGE_PRIVATE_DIR: fx.root },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      groundTruthPath: fx.groundTruthPath,
      auditEventsPath: fx.auditEventsPath,
      reviewsDir: join(fx.root, "raw-artifacts", "reviews"),
      overlayPath,
      examplesDir: join(fx.root, "examples"),
      casesDir: join(fx.root, "cases"),
      save: extra.save ?? false,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("builds from the save the verdict judged", async () => {
    const { code, err } = await build(fixture());
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  it("refuses, exit 2, a saved review changed after the verdict", async () => {
    const fx = fixture();
    writeFileSync(fx.savePath, fx.saveText.replace('"findings":[]', '"findings": []'));
    const { code, err } = await build(fx);
    expect(code).toBe(2);
    expect(err).toContain("the verdict's inputs changed since it was recorded");
  });

  it("refuses, exit 2, a template changed after the verdict", async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, "templates", "t9", "template.json"), TEMPLATE_TEXT.replace("one", "two"));
    expect((await build(fx)).code).toBe(2);
  });

  it("still builds when the answer key gains an amendment after the verdict", async () => {
    const fx = fixture();
    const amendment = { kind: "amendment", amends: CASE_ID, at: "2026-11-02T00:00:00.000Z", change: { note: "n" } };
    appendFileSync(fx.groundTruthPath, `${JSON.stringify({ ...amendment, reason: "r", evidence: "e" })}\n`);
    expect((await build(fx)).code).toBe(0);
  });

  it("refuses, exit 2, a final verdict on a save that never finished", async () => {
    const { code, err } = await build(fixture({ state: "review incomplete" }));
    expect(code).toBe(2);
    expect(err).toContain("only review_incomplete can");
  });

  it("never uses a save of the same commit on another PR (M44b)", async () => {
    const fx = fixture();
    const other = join(fx.root, "raw-artifacts", "reviews", "target-pr8");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, `${COMMIT.slice(0, 7)}.review.json`), fx.saveText.replace('"pr":7', '"pr":8'));
    rmSync(fx.savePath);
    const { code, err } = await build(fx);
    expect(code).toBe(2);
    expect(err).toContain("on PR 7");
  });

  it("refuses, exit 1, a record that leaks a private path or fails the schema (M44, M44c)", async () => {
    const leak = await build(fixture(), { overlay: { detection: { notes: ["see private/raw-artifacts/x"] } } });
    expect(leak.code).toBe(1);
    expect(leak.out).toContain("problems found");
    const invalid = await build(fixture(), { overlay: { challenge: { verdict: "maybe", note: "n" } } });
    expect(invalid.code).toBe(1);
    expect(invalid.out).toContain("/challenge/verdict");
  });

  it("--save writes private/cases/<id>.json, and never replaces a different record there (#249)", async () => {
    const fx = fixture();
    expect((await build(fx, { save: true })).code).toBe(0);
    const saved = readFileSync(join(fx.root, "cases", `${CASE_ID}.json`), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ caseId: CASE_ID, human: { disposition: "confirmed_missed" } });
    expect((await build(fx, { save: true })).code).toBe(0);
    writeFileSync(join(fx.root, "cases", `${CASE_ID}.json`), "{}\n");
    const again = await build(fx, { save: true });
    expect(again.code).toBe(2);
    expect(again.err).toContain("already holds a different record");
    expect(readFileSync(join(fx.root, "cases", `${CASE_ID}.json`), "utf8")).toBe("{}\n");
  });
});

describe("run: a review stage whose PR can't be read (Qodo on PR 264)", () => {
  it("refuses, exit 2, rather than fall back to an overlay's legacy findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "case-build-pr-"));
    const commit = "9".repeat(40);
    writeFileSync(
      join(root, "ground-truth.jsonl"),
      `${JSON.stringify({ caseId: "FF-9004", kind: "sabotage", templateId: "t", injectionCommit: commit })}\n`,
    );
    const events = [
      { eventId: "a", type: "review.recorded", caseId: "FF-9004", at: "2026-11-01T00:00:00Z", pr: { repo: "o/t" } },
      { eventId: "b", type: "case.adjudicated", caseId: "FF-9004", at: "2026-11-01T00:01:00Z", disposition: "x" },
    ];
    writeFileSync(join(root, "audit-events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    writeFileSync(join(root, "overlay.json"), JSON.stringify({ legacyFindingsPath: "nowhere.json" }));
    const err: string[] = [];
    const code = await run("FF-9004", {
      env: { FAULTFORGE_PRIVATE_DIR: root },
      log: () => {},
      error: (l) => err.push(l),
      overlayPath: join(root, "overlay.json"),
      reviewsDir: join(root, "reviews"),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("names no readable PR");
  });
});

describe("run: the findings come from the file the verdict judged (Qodo on PR 264)", () => {
  it("refuses, exit 2, when the verdict names another file than the save found", async () => {
    const root = mkdtempSync(join(tmpdir(), "case-build-file-"));
    const commit = "8".repeat(40);
    mkdirSync(join(root, "templates", "t8"), { recursive: true });
    writeFileSync(join(root, "templates", "t8", "template.json"), '{"match":{"kindTerms":["x"]}}');
    writeFileSync(
      join(root, "ground-truth.jsonl"),
      `${JSON.stringify({ caseId: "FF-9005", kind: "sabotage", templateId: "t8", targetRepo: "https://github.com/o/t.git", targetCommit: "a".repeat(40), injectionCommit: commit, injectedFile: "src/x.ts", injectedLines: [1, 1] })}\n`,
    );
    const dir = join(root, "reviews", "target-pr3");
    mkdirSync(dir, { recursive: true });
    const save = { pr: 3, headSha: commit, state: "complete", reviewSeenCompleteAt: null, findings: [] };
    writeFileSync(join(dir, `${commit.slice(0, 7)}.review.json`), JSON.stringify(save));
    writeFileSync(join(root, "judged.review.json"), JSON.stringify({ ...save, findings: [] }));
    const events = [
      { eventId: "a", type: "sabotage.injected", caseId: "FF-9005", at: "2026-11-01T00:00:00Z" },
      {
        eventId: "b",
        type: "review.recorded",
        caseId: "FF-9005",
        at: "2026-11-01T00:01:00Z",
        pr: { repo: "o/t", number: 3, url: "https://github.com/o/t/pull/3" },
        review: { reviewer: "q", path: "p", configVersion: "v", reviewedCommit: commit, reviewedAt: "t", url: "u" },
      },
      {
        eventId: "c",
        type: "case.adjudicated",
        caseId: "FF-9005",
        at: "2026-11-01T00:02:00Z",
        disposition: "confirmed_missed",
        by: "o",
        reviewFile: "judged.review.json",
      },
    ];
    writeFileSync(join(root, "audit-events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const err: string[] = [];
    const code = await run("FF-9005", {
      env: { FAULTFORGE_PRIVATE_DIR: root },
      log: () => {},
      error: (l) => err.push(l),
      overlayPath: join(root, "none.json"),
      reviewsDir: join(root, "reviews"),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("the verdict judged");
  });
});
