import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkTree,
  extractReviewRecord,
  parseArgs,
  type ReviewRecord,
  readReviewRecords,
  treeOfCommit,
} from "./review-gate.ts";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const BASE = "c".repeat(40);

/** A saved review payload the way Qodo returns it, with only the fields the gate reads. */
function payload(opts: {
  checkpointTree?: string;
  snapshotTree?: string;
  complete?: boolean;
  inventoryComplete?: boolean;
  effort?: string;
  at?: string;
}) {
  return {
    findings: [],
    finding_state: { complete: opts.inventoryComplete ?? true },
    meta: {
      ...(opts.checkpointTree
        ? {
            checkpoint: {
              tree_sha: opts.checkpointTree,
              base_sha: BASE,
              created_at: opts.at ?? "2026-11-12T10:00:00Z",
            },
          }
        : {}),
      coverage: { complete: opts.complete ?? true },
      run: {
        effort: { effective: opts.effort ?? "standard" },
        ...(opts.snapshotTree ? { snapshot: { base_sha: BASE, tree_sha: opts.snapshotTree } } : {}),
      },
    },
  };
}

const record = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  source: "r1/review.json",
  trees: [TREE_A],
  baseSha: BASE,
  repo: null,
  complete: true,
  skipped: false,
  at: Date.parse("2026-11-12T10:00:00Z"),
  ...overrides,
});

describe("extractReviewRecord", () => {
  it("reads the tree from meta.checkpoint.tree_sha", () => {
    const r = extractReviewRecord(payload({ checkpointTree: TREE_A }), "x", 0);
    expect(r).toMatchObject({ trees: [TREE_A], baseSha: BASE, complete: true, skipped: false });
  });

  it("reads the tree from meta.run.snapshot.tree_sha when a first run has no checkpoint", () => {
    const r = extractReviewRecord(payload({ snapshotTree: TREE_B }), "x", 0);
    expect(r?.trees).toEqual([TREE_B]);
  });

  it("keeps both trees when a review records two", () => {
    const r = extractReviewRecord(payload({ checkpointTree: TREE_A, snapshotTree: TREE_B }), "x", 0);
    expect(r?.trees.sort()).toEqual([TREE_A, TREE_B]);
  });

  it("reads through the managed-agent envelope the early saves used", () => {
    const wrapped = { output: JSON.stringify({ result: payload({ checkpointTree: TREE_A }), status: "completed" }) };
    expect(extractReviewRecord(wrapped, "x", 0)?.trees).toEqual([TREE_A]);
  });

  it("marks a skipped review and an incomplete one", () => {
    expect(extractReviewRecord(payload({ checkpointTree: TREE_A, effort: "skip" }), "x", 0)?.skipped).toBe(true);
    expect(extractReviewRecord(payload({ checkpointTree: TREE_A, complete: false }), "x", 0)?.complete).toBe(false);
  });

  it("treats a review that does not say its coverage was complete as incomplete", () => {
    const p = payload({ checkpointTree: TREE_A });
    (p.meta as { coverage?: unknown }).coverage = undefined;
    expect(extractReviewRecord(p, "x", 0)?.complete).toBe(false);
  });

  it("counts a review whose finding inventory was not complete as incomplete", () => {
    const r = extractReviewRecord(payload({ checkpointTree: TREE_A, inventoryComplete: false }), "x", 0);
    expect(r?.complete).toBe(false);
  });

  it("counts a review whose local snapshot left a file out as incomplete, whatever Qodo's flag says", () => {
    const r = extractReviewRecord(payload({ checkpointTree: TREE_A }), "x", 0, { repo: "o/r", scopeComplete: false });
    expect(r?.complete).toBe(false);
    expect(r?.repo).toBe("o/r");
  });

  it("is null for anything that is not a review with a tree", () => {
    expect(extractReviewRecord({ status: "working" }, "x", 0)).toBeNull();
    expect(extractReviewRecord(null, "x", 0)).toBeNull();
    expect(extractReviewRecord("text", "x", 0)).toBeNull();
    expect(extractReviewRecord(payload({}), "x", 0)).toBeNull();
  });

  it("ignores a tree value that is not a 40-character hash", () => {
    expect(extractReviewRecord(payload({ checkpointTree: "not-a-hash" }), "x", 0)).toBeNull();
  });
});

describe("checkTree", () => {
  it("is covered on an exact match with a complete, not skipped review", () => {
    expect(checkTree(TREE_A, [record()])).toMatchObject({ covered: true });
  });

  it("is not covered when one file changed after the review (a different tree)", () => {
    const result = checkTree(TREE_B, [record()]);
    expect(result.covered).toBe(false);
    expect(result.nearest?.trees).toEqual([TREE_A]);
  });

  it("is not covered when the matching review was skipped", () => {
    const result = checkTree(TREE_A, [record({ skipped: true })]);
    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/skipped/);
  });

  it("is not covered when the matching review's coverage was incomplete", () => {
    const result = checkTree(TREE_A, [record({ complete: false })]);
    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/incomplete/);
  });

  it("is covered by a later skipped review only if an earlier complete one matches the same tree", () => {
    const older = record({ source: "old", at: 1_000 });
    const newer = record({ source: "new", skipped: true, at: 2_000 });
    expect(checkTree(TREE_A, [newer, older])).toMatchObject({ covered: true, by: { source: "old" } });
  });

  it("is covered when a commit's tree matches an older review of the same tree", () => {
    const older = record({ at: Date.parse("2026-11-10T00:00:00Z") });
    const other = record({ trees: [TREE_B], at: Date.parse("2026-11-12T00:00:00Z") });
    expect(checkTree(TREE_A, [other, older]).covered).toBe(true);
  });

  it("ignores a complete review of another repository, even with an identical tree", () => {
    const other = record({ repo: "owner/other" });
    expect(checkTree(TREE_A, [other], { repo: "owner/this" }).covered).toBe(false);
    expect(checkTree(TREE_A, [other], { repo: "owner/other" }).covered).toBe(true);
  });

  it("keeps a review that does not say which repository only when its base commit is in this checkout", () => {
    const unlabelled = record({ repo: null });
    expect(checkTree(TREE_A, [unlabelled], { repo: "owner/this", hasCommit: () => true }).covered).toBe(true);
    expect(checkTree(TREE_A, [unlabelled], { repo: "owner/this", hasCommit: () => false }).covered).toBe(false);
    expect(checkTree(TREE_A, [record({ repo: null, baseSha: null })], { hasCommit: () => true }).covered).toBe(false);
  });

  it("ignores a review made against a base commit this checkout does not have", () => {
    const scope = { hasCommit: (sha: string) => sha !== BASE };
    expect(checkTree(TREE_A, [record()], scope).covered).toBe(false);
    expect(checkTree(TREE_A, [record()], { hasCommit: () => true }).covered).toBe(true);
  });

  it("names the most recent review as the nearest when none matches", () => {
    const older = record({ source: "old", at: 1_000 });
    const newer = record({ source: "new", trees: [TREE_B], at: 2_000 });
    expect(checkTree("d".repeat(40), [older, newer]).nearest?.source).toBe("new");
  });

  it("is not covered, with no nearest, when there are no reviews at all", () => {
    expect(checkTree(TREE_A, [])).toMatchObject({ covered: false, nearest: null });
  });
});

describe("readReviewRecords", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads reviews from nested folders, skips polls and non-reviews, and uses the file time as the age", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    mkdirSync(join(dir, "local-reviews", "r1"), { recursive: true });
    mkdirSync(join(dir, "day-08"), { recursive: true });
    writeFileSync(join(dir, "local-reviews", "r1", "review.json"), JSON.stringify(payload({ snapshotTree: TREE_A })));
    writeFileSync(
      join(dir, "local-reviews", "r1", "poll-1.raw.json"),
      JSON.stringify(payload({ snapshotTree: TREE_B })),
    );
    writeFileSync(join(dir, "day-08", "review-1.raw.json"), JSON.stringify(payload({ checkpointTree: TREE_B })));
    writeFileSync(join(dir, "day-08", "notes.json"), "not json {");
    const when = new Date("2026-11-11T09:00:00Z");
    utimesSync(join(dir, "local-reviews", "r1", "review.json"), when, when);

    const { records } = readReviewRecords(dir);
    expect(records.map((r) => r.trees[0]).sort()).toEqual([TREE_A, TREE_B]);
    expect(records.find((r) => r.trees[0] === TREE_A)?.at).toBe(when.getTime());
  });

  it("reads split.json beside a review: its repository, and an incomplete scope makes the review incomplete", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    const ok = join(dir, "ok");
    const bad = join(dir, "bad");
    mkdirSync(ok);
    mkdirSync(bad);
    writeFileSync(join(ok, "review.json"), JSON.stringify(payload({ snapshotTree: TREE_A })));
    writeFileSync(
      join(ok, "split.json"),
      JSON.stringify({ repo: "o/r", diffBuilt: true, excludedFiles: [], skippedFiles: [] }),
    );
    writeFileSync(join(bad, "review.json"), JSON.stringify(payload({ snapshotTree: TREE_B })));
    writeFileSync(
      join(bad, "split.json"),
      JSON.stringify({ repo: "o/r", diffBuilt: true, excludedFiles: ["img.bin"], skippedFiles: [{ file: "img.bin" }] }),
    );

    const { records } = readReviewRecords(dir);
    expect(records.find((r) => r.trees[0] === TREE_A)).toMatchObject({ complete: true, repo: "o/r" });
    expect(records.find((r) => r.trees[0] === TREE_B)).toMatchObject({ complete: false, repo: "o/r" });
  });

  it("treats a split.json whose diff was never built as an incomplete scope", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    writeFileSync(join(dir, "review.json"), JSON.stringify(payload({ snapshotTree: TREE_A })));
    writeFileSync(
      join(dir, "split.json"),
      JSON.stringify({ repo: "o/r", diffBuilt: false, excludedFiles: null, skippedFiles: null }),
    );
    expect(readReviewRecords(dir).records[0]?.complete).toBe(false);
  });

  it("ignores pull-request reviews saved under reviews/, even when they record a tree", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    mkdirSync(join(dir, "reviews", "faultforge-pr1"), { recursive: true });
    writeFileSync(
      join(dir, "reviews", "faultforge-pr1", "abc.review.json"),
      JSON.stringify(payload({ checkpointTree: TREE_A })),
    );
    expect(readReviewRecords(dir).records).toEqual([]);
  });

  it("counts a review as incomplete when its split.json exists but cannot be parsed", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    writeFileSync(join(dir, "review.json"), JSON.stringify(payload({ snapshotTree: TREE_A })));
    writeFileSync(join(dir, "split.json"), "{ not json");
    expect(readReviewRecords(dir).records[0]?.complete).toBe(false);
  });

  it("still counts a review with no split.json at all, as older saves have none", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    writeFileSync(join(dir, "review.json"), JSON.stringify(payload({ snapshotTree: TREE_A })));
    expect(readReviewRecords(dir).records[0]?.complete).toBe(true);
  });

  it("reports a folder it cannot list instead of silently reading less", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    // A file where a folder is expected cannot be listed on any platform.
    writeFileSync(join(dir, "not-a-folder"), "x");
    const result = readReviewRecords(join(dir, "not-a-folder"));
    expect(result.records).toEqual([]);
    expect(result.problems[0]).toMatch(/cannot list/);
  });

  it("is empty for a folder that does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    const result = readReviewRecords(join(dir, "missing"));
    expect(result.records).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });
});

describe("treeOfCommit on a real git repository", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  it("is the tree the commit contains, the same one `git write-tree` gave when it was staged", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-git-"));
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    sh(dir, "add", ".");
    const staged = sh(dir, "write-tree");
    sh(dir, "commit", "-qm", "first");
    const commit = sh(dir, "rev-parse", "HEAD");

    expect(treeOfCommit(dir, commit)).toBe(staged);
    expect(treeOfCommit(dir, "HEAD")).toBe(staged);
  });

  it("changes when one file changes, so the same review no longer covers it", () => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-git-"));
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "first");
    const reviewed = treeOfCommit(dir, "HEAD");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    sh(dir, "commit", "-qam", "second");

    const result = checkTree(treeOfCommit(dir, "HEAD"), [record({ trees: [reviewed] })]);
    expect(result.covered).toBe(false);
  });
});

describe("parseArgs", () => {
  it("reads the repo key and an optional commit", () => {
    expect(parseArgs(["faultforge"])).toEqual({ repoKey: "faultforge", commit: null });
    expect(parseArgs(["faultforge", "--commit", "HEAD"])).toEqual({ repoKey: "faultforge", commit: "HEAD" });
  });

  it("rejects an empty commit instead of falling back to the staged tree", () => {
    expect(parseArgs(["faultforge", "--commit", ""])).toBeNull();
    expect(parseArgs(["faultforge", "--commit="])).toBeNull();
  });

  it("rejects a missing repo key and extra arguments", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["a", "b"])).toBeNull();
  });
});
