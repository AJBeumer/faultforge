import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTable,
  casePrs,
  citationProblems,
  type EvidenceTable,
  readSavedReviews,
  type SavedReview,
} from "./rules-evidence.ts";

// Review shapes mirror the `*.review.json` files `review:wait` saves under private/raw-artifacts,
// which aren't committed to this repo (.gitignore excludes private/) and so can't be read in tests.

const finding = (id: string, title = "A finding") => ({
  id,
  file: "src/thing.ts",
  lines: [3, 9] as [number, number],
  severity: "remediation_recommended",
  category: "Reliability",
  title,
  description: "What went wrong.",
});

const review = (overrides: Partial<SavedReview>): SavedReview => ({
  repo: "AJBeumer/faultforge",
  pr: 75,
  headSha: "aaa1111",
  reviewEffort: "lite",
  recordedAt: "2026-11-09T11:00:00Z",
  findings: [],
  openFindings: [],
  ...overrides,
});

describe("buildTable", () => {
  it("keeps one row per finding and marks open only what the last review still lists", () => {
    const first = review({ findings: [finding("f-closed"), finding("f-open")], openFindings: [finding("f-closed")] });
    const last = review({
      headSha: "bbb2222",
      reviewEffort: "standard",
      recordedAt: "2026-11-09T12:00:00Z",
      findings: [],
      openFindings: [finding("f-open"), finding("f-new")],
    });
    const table = buildTable(
      [
        { key: "faultforge", review: last },
        { key: "faultforge", review: first },
      ],
      new Set(),
    );

    expect(table.rows.map((r) => r.id)).toEqual(["f-closed", "f-open", "f-new"]);
    expect(table.rows.map((r) => r.openAtLastReview)).toEqual([false, true, true]);
    const closed = table.rows[0];
    expect(closed).toMatchObject({ commit: "aaa1111", reviewDepth: "lite", repo: "faultforge", pr: 75 });
    expect(table.prsCovered).toBe(1);
  });

  it("leaves case PRs out and reports only their count", () => {
    const exam = review({ repo: "AJBeumer/faultforge-target", pr: 1, findings: [finding("f-exam")] });
    const ordinary = review({ findings: [finding("f-ok")] });
    const table = buildTable(
      [
        { key: "target", review: exam },
        { key: "faultforge", review: ordinary },
      ],
      new Set(["AJBeumer/faultforge-target#1"]),
    );

    expect(table.rows.map((r) => r.id)).toEqual(["f-ok"]);
    expect(table.casePrsExcluded).toBe(1);
    expect(JSON.stringify(table)).not.toContain("f-exam");
  });

  it("builds an empty table from no reviews", () => {
    expect(buildTable([], new Set()).rows).toEqual([]);
  });
});

describe("readSavedReviews and casePrs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads review files per PR folder and case PRs from the records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-"));
    dirs.push(dir);
    mkdirSync(join(dir, "reviews", "faultforge-pr75"), { recursive: true });
    mkdirSync(join(dir, "reviews", "not-a-pr-folder"), { recursive: true });
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "reviews", "faultforge-pr75", "aaa.review.json"), JSON.stringify(review({})));
    writeFileSync(join(dir, "reviews", "faultforge-pr75", "aaa.qodo-api.raw.json"), "{}");
    writeFileSync(
      join(dir, "cases", "FF-0001.json"),
      JSON.stringify({ caseId: "FF-0001", pr: { repo: "AJBeumer/faultforge-target", number: 1 } }),
    );

    const reviews = readSavedReviews(join(dir, "reviews"));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ key: "faultforge", review: { pr: 75 } });
    expect(casePrs(join(dir, "cases"))).toEqual(new Set(["AJBeumer/faultforge-target#1"]));
    expect(casePrs(join(dir, "missing"))).toEqual(new Set());
  });
});

describe("citationProblems", () => {
  const table: EvidenceTable = {
    builtAt: "2026-11-09T12:00:00Z",
    rows: [
      {
        ...finding("1a73417f-6d4d-44cf-836b-980e6f9ca61b"),
        id: "1a73417f-6d4d-44cf-836b-980e6f9ca61b",
        repo: "faultforge",
        github: "AJBeumer/faultforge",
        pr: 75,
        commit: "aaa1111",
        reviewDepth: "lite",
        recordedAt: "2026-11-09T11:00:00Z",
        openAtLastReview: false,
      },
    ],
    prsCovered: 1,
    casePrsExcluded: 0,
  };

  it("passes citations that are in the table, by id, repo#pr and URL", () => {
    const text =
      "Seen in finding 1a73417f-6d4d-44cf-836b-980e6f9ca61b on faultforge#75 " +
      "(https://github.com/AJBeumer/faultforge/pull/75). Ticket #41 and bare words like day#3 are not citations.";
    expect(citationProblems(text, table)).toEqual({ problems: [], cited: 3 });
  });

  it("names every citation that is not in the table", () => {
    const text = "finding 99999999-9999-4999-8999-999999999999 on faultforge#9 github.com/AJBeumer/faultforge/pull/9";
    const { problems } = citationProblems(text, table);
    expect(problems).toEqual([
      "finding 99999999-9999-4999-8999-999999999999 is not in the table",
      "PR faultforge#9 is not in the table",
      "PR AJBeumer/faultforge#9 is not in the table",
    ]);
  });

  it("counts nothing when there are no citations", () => {
    expect(citationProblems("no references here", table)).toEqual({ problems: [], cited: 0 });
  });
});
