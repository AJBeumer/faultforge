import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTable,
  casePrs,
  citationProblems,
  type EvidenceTable,
  groundTruthCommits,
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
  state: "complete",
  reviewEffort: "lite",
  recordedAt: "2026-11-09T11:00:00Z",
  findings: [],
  openFindings: [],
  ...overrides,
});

const nothingExcluded = { prs: new Set<string>(), commits: new Set<string>() };

describe("buildTable", () => {
  it("keeps one row per finding and marks open only what the last complete review still lists", () => {
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
      nothingExcluded,
    );

    expect(table.rows.map((r) => r.id)).toEqual(["f-closed", "f-open", "f-new"]);
    expect(table.rows.map((r) => r.openAtLastReview)).toEqual([false, true, true]);
    const closed = table.rows[0];
    expect(closed).toMatchObject({ firstSeenCommit: "aaa1111", reviewDepth: "lite", repo: "faultforge", pr: 75 });
    expect(table.prsCovered).toBe(1);
  });

  it("lists a reviewed PR with no findings among the covered PRs, so it stays citable", () => {
    const clean = review({ pr: 19, repo: "AJBeumer/faultforge-target", findings: [], openFindings: [] });
    const table = buildTable([{ key: "target", review: clean }], nothingExcluded);
    expect(table.rows).toEqual([]);
    expect(table.prs).toEqual([{ repo: "target", github: "AJBeumer/faultforge-target", pr: 19 }]);
    expect(table.prsCovered).toBe(1);
  });

  it("never calls a finding closed on the word of an incomplete review", () => {
    const complete = review({ findings: [finding("f-raised")], openFindings: [finding("f-raised")] });
    const timedOut = review({
      headSha: "bbb2222",
      state: "review incomplete",
      recordedAt: "2026-11-09T12:00:00Z",
      openFindings: [],
    });
    const table = buildTable(
      [
        { key: "faultforge", review: complete },
        { key: "faultforge", review: timedOut },
      ],
      nothingExcluded,
    );
    expect(table.rows.map((r) => r.openAtLastReview)).toEqual([true]);

    const onlyIncomplete = buildTable([{ key: "faultforge", review: timedOut }], nothingExcluded);
    expect(onlyIncomplete.rows.every((r) => r.openAtLastReview)).toBe(true);
  });

  it("keeps a finding open when it first appears after the last complete review", () => {
    const completeFirst = review({ findings: [], openFindings: [] });
    const timedOutLater = review({
      headSha: "bbb2222",
      state: "review incomplete",
      recordedAt: "2026-11-09T12:00:00Z",
      findings: [finding("f-late")],
      openFindings: [],
    });
    const table = buildTable(
      [
        { key: "faultforge", review: completeFirst },
        { key: "faultforge", review: timedOutLater },
      ],
      nothingExcluded,
    );
    expect(table.rows.map((r) => [r.id, r.openAtLastReview])).toEqual([["f-late", true]]);
  });

  it("does not list a PR as citable on a skipped or timed-out review alone", () => {
    const skipped = review({ pr: 90, state: "skipped by Qodo", findings: [], openFindings: [] });
    const table = buildTable([{ key: "faultforge", review: skipped }], nothingExcluded);
    expect(table.prs).toEqual([]);
  });

  it("leaves case PRs out, by case record and by answer-key commit, and reports only counts", () => {
    const byRecord = review({ repo: "AJBeumer/faultforge-target", pr: 1, findings: [finding("f-exam")] });
    const byCommitEarly = review({ repo: "AJBeumer/faultforge-target", pr: 2, findings: [finding("f-exam2a")] });
    const byCommitLate = review({
      repo: "AJBeumer/faultforge-target",
      pr: 2,
      headSha: "inj9999",
      recordedAt: "2026-11-09T12:00:00Z",
      findings: [finding("f-exam2b")],
    });
    const ordinary = review({ findings: [finding("f-ok")] });
    const table = buildTable(
      [
        { key: "target", review: byRecord },
        { key: "target", review: byCommitEarly },
        { key: "target", review: byCommitLate },
        { key: "faultforge", review: ordinary },
      ],
      { prs: new Set(["AJBeumer/faultforge-target#1"]), commits: new Set(["inj9999"]) },
    );

    expect(table.rows.map((r) => r.id)).toEqual(["f-ok"]);
    expect(table.casePrsExcluded).toBe(2);
    expect(JSON.stringify(table)).not.toContain("exam");
  });

  it("builds an empty table from no reviews", () => {
    expect(buildTable([], nothingExcluded).rows).toEqual([]);
  });
});

describe("readSavedReviews, casePrs and groundTruthCommits", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads review files per PR folder, case PRs from the records, commits from the answer key", () => {
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
    writeFileSync(
      join(dir, "ground-truth.jsonl"),
      `${JSON.stringify({ caseId: "FF-0001", injectionCommit: "inj9999" })}\n\n${JSON.stringify({ caseId: "FF-0002", injectionCommit: "inj8888", reviewedCommit: "rev7777" })}\n`,
    );

    const reviews = readSavedReviews(join(dir, "reviews"));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ key: "faultforge", review: { pr: 75 } });
    expect(casePrs(join(dir, "cases"))).toEqual(new Set(["AJBeumer/faultforge-target#1"]));
    expect(groundTruthCommits(join(dir, "ground-truth.jsonl"))).toEqual(new Set(["inj9999", "inj8888", "rev7777"]));
  });

  it("excludes both the commit an amendment replaced and the one it names (AUD-N1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-"));
    dirs.push(dir);
    const amendment = { kind: "amendment", amends: "FF-9001", change: { injectionCommit: "new2222" }, reason: "r" };
    writeFileSync(
      join(dir, "ground-truth.jsonl"),
      `${JSON.stringify({ caseId: "FF-9001", injectionCommit: "old1111" })}\n${JSON.stringify(amendment)}\n`,
    );
    expect(groundTruthCommits(join(dir, "ground-truth.jsonl"))).toEqual(new Set(["old1111", "new2222"]));
  });

  it("keeps a commit two amendments passed through excluded (Qodo on PR 260)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-"));
    dirs.push(dir);
    const amend = (sha: string) => ({
      kind: "amendment",
      amends: "FF-9001",
      change: { injectionCommit: sha },
      reason: "r",
    });
    writeFileSync(
      join(dir, "ground-truth.jsonl"),
      [{ caseId: "FF-9001", injectionCommit: "aaa1111" }, amend("bbb2222"), amend("ccc3333")]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(""),
    );
    expect(groundTruthCommits(join(dir, "ground-truth.jsonl"))).toEqual(new Set(["aaa1111", "bbb2222", "ccc3333"]));
  });

  it("ignores the commit of an amendment that names no entry, so it can't hide an unrelated PR (Qodo on PR 260)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-"));
    dirs.push(dir);
    const stray = { kind: "amendment", amends: "FF-9999", change: { injectionCommit: "stray33" }, reason: "r" };
    writeFileSync(
      join(dir, "ground-truth.jsonl"),
      `${JSON.stringify({ caseId: "FF-9001", injectionCommit: "old1111" })}\n${JSON.stringify(stray)}\n`,
    );
    expect(groundTruthCommits(join(dir, "ground-truth.jsonl"))).toEqual(new Set(["old1111"]));
  });

  it("skips a stray file that matches the folder pattern instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-"));
    dirs.push(dir);
    mkdirSync(join(dir, "reviews", "faultforge-pr75"), { recursive: true });
    writeFileSync(join(dir, "reviews", "faultforge-pr75", "aaa.review.json"), JSON.stringify(review({})));
    // Not a folder, but matches the "<repoKey>-pr<N>" pattern.
    writeFileSync(join(dir, "reviews", "target-pr9"), "leftover file, not a reviews folder");

    const reviews = readSavedReviews(join(dir, "reviews"));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ key: "faultforge", review: { pr: 75 } });
  });

  it("fails closed: an unreadable folder or answer key is an error, never an empty result", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-"));
    dirs.push(dir);
    expect(() => readSavedReviews(join(dir, "missing-reviews"))).toThrow(/cannot read the saved reviews/);
    expect(() => casePrs(join(dir, "missing-cases"))).toThrow(/cannot read the case records/);
    expect(() => groundTruthCommits(join(dir, "missing.jsonl"))).toThrow(/cannot read the answer key/);
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
        firstSeenCommit: "aaa1111",
        reviewDepth: "lite",
        recordedAt: "2026-11-09T11:00:00Z",
        openAtLastReview: false,
      },
    ],
    prs: [
      { repo: "faultforge", github: "AJBeumer/faultforge", pr: 75 },
      { repo: "target", github: "AJBeumer/faultforge-target", pr: 19 },
    ],
    prsCovered: 2,
    casePrsExcluded: 0,
  };

  it("passes citations that are in the table, by id, repo#pr and URL", () => {
    const text =
      "Seen in finding 1a73417f-6d4d-44cf-836b-980e6f9ca61b on faultforge#75 " +
      "(https://github.com/AJBeumer/faultforge/pull/75). Ticket #41 and bare words like day#3 are not citations.";
    expect(citationProblems(text, table)).toEqual({ problems: [], cited: 3 });
  });

  it("accepts a covered PR whose review found nothing", () => {
    expect(citationProblems("clean on target#19", table)).toEqual({ problems: [], cited: 1 });
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

  it("checks a configured repo key even when the table has no rows for it", () => {
    const { problems } = citationProblems("see target#9", table, new Set(["faultforge", "target"]));
    expect(problems).toEqual(["PR target#9 is not in the table"]);
  });

  it("accepts a bare PR number only when exactly one covered PR has it", () => {
    const { problems, cited } = citationProblems("fixed in PR 75 and PR #9", table);
    expect(problems).toEqual(['"PR #9" is not in the table']);
    expect(cited).toBe(2);

    const twoRepos = {
      ...table,
      prs: [...table.prs, { repo: "target", github: "AJBeumer/faultforge-target", pr: 75 }],
    };
    expect(citationProblems("see PR 75", twoRepos).problems).toEqual([
      '"PR 75" is ambiguous (faultforge#75, target#75); name the repository',
    ]);
  });

  it("counts nothing when there are no citations", () => {
    expect(citationProblems("no references here", table)).toEqual({ problems: [], cited: 0 });
  });
});
