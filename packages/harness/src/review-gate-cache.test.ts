import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCacheFile, ReviewCache } from "./review-gate-cache.ts";
import { readReviewRecords } from "./review-gate-records.ts";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);

/** A saved local review that records `tree`, complete unless said otherwise. */
const review = (tree: string) =>
  JSON.stringify({
    finding_state: { complete: true },
    meta: {
      coverage: { complete: true },
      run: { effort: { effective: "standard" }, snapshot: { base_sha: "c".repeat(40), tree_sha: tree } },
    },
  });

describe("review:gate's cache (AUD-N6)", () => {
  let dir: string;
  let evidence: string;
  let cacheFile: string;
  const read = () => {
    const cache = ReviewCache.load(cacheFile);
    const result = readReviewRecords(evidence, cache);
    cache.save();
    return result;
  };
  const sorted = (r: ReturnType<typeof readReviewRecords>) =>
    [...r.records].sort((a, b) => a.source.localeCompare(b.source));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "review-gate-cache-"));
    evidence = join(dir, "evidence");
    cacheFile = join(dir, "cache", "gate.json");
    mkdirSync(join(evidence, "local-reviews", "r1"), { recursive: true });
    mkdirSync(join(evidence, "other"), { recursive: true });
    writeFileSync(join(evidence, "local-reviews", "r1", "review.json"), review(TREE_A));
    writeFileSync(
      join(evidence, "local-reviews", "r1", "split.json"),
      JSON.stringify({ repo: "o/r", diffBuilt: true, excludedFiles: [], skippedFiles: [] }),
    );
    writeFileSync(join(evidence, "other", "notes.json"), "not json {");
    writeFileSync(join(evidence, "other", "status.json"), JSON.stringify({ status: "working" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses nothing again on a second run, and finds the same records", () => {
    const first = read();
    expect(first.parsed).toBe(4); // the review, its split.json, and two files that are not reviews
    const second = read();
    expect(second.parsed).toBe(0);
    expect(sorted(second)).toEqual(sorted(first));
    expect(sorted(second)).toEqual(sorted(readReviewRecords(evidence)));
  });

  it("parses only the new files when unrelated files are added, however many there were before", () => {
    for (let i = 0; i < 200; i++) writeFileSync(join(evidence, "other", `old-${i}.json`), JSON.stringify({ i }));
    expect(read().parsed).toBe(204);
    for (let i = 0; i < 5; i++) writeFileSync(join(evidence, "other", `new-${i}.json`), JSON.stringify({ i }));
    const next = read();
    expect(next.parsed).toBe(5);
    expect(next.records.map((r) => r.trees[0])).toEqual([TREE_A]);
  });

  it("parses a review again when it changes", () => {
    read();
    const file = join(evidence, "local-reviews", "r1", "review.json");
    writeFileSync(file, review(TREE_B));
    const when = new Date("2026-11-11T09:00:00Z");
    utimesSync(file, when, when);
    const next = read();
    expect(next.parsed).toBe(1);
    expect(next.records.map((r) => r.trees[0])).toEqual([TREE_B]);
    expect(next.records[0]?.at).toBe(when.getTime());
  });

  it("parses a review again when the split.json beside it changes, appears or goes", () => {
    read();
    const split = join(evidence, "local-reviews", "r1", "split.json");
    writeFileSync(split, JSON.stringify({ repo: "o/r", diffBuilt: true, excludedFiles: ["x.bin"], skippedFiles: [] }));
    let next = read();
    expect(next.parsed).toBe(2); // split.json itself, and the review beside it;
    expect(next.records[0]).toMatchObject({ complete: false, repo: "o/r" });

    rmSync(split);
    next = read();
    expect(next.parsed).toBe(1);
    expect(next.records[0]).toMatchObject({ complete: true, repo: null });

    writeFileSync(split, JSON.stringify({ repo: "x/y", diffBuilt: true, excludedFiles: [], skippedFiles: [] }));
    next = read();
    expect(next.parsed).toBe(2);
    expect(next.records[0]).toMatchObject({ complete: true, repo: "x/y" });
  });

  it("reads everything, with the same answer, when the cache is missing, corrupt or from other code", () => {
    const fresh = readReviewRecords(evidence);
    read();
    writeFileSync(cacheFile, "{ broken");
    expect(read()).toMatchObject({ parsed: 4 });

    const other = ReviewCache.load(cacheFile, "some other code");
    const result = readReviewRecords(evidence, other);
    expect(result.parsed).toBe(4);
    expect(sorted(result)).toEqual(sorted(fresh));

    // A cache entry that has been tampered into a shape no reader writes is not trusted either.
    const doc = JSON.parse(readFileSync(cacheFile, "utf8")) as { entries: Record<string, { record: unknown }> };
    for (const entry of Object.values(doc.entries)) entry.record = { trees: "not a list" };
    writeFileSync(cacheFile, JSON.stringify(doc));
    expect(read()).toMatchObject({ parsed: 4 });

    rmSync(cacheFile);
    const again = read();
    expect(again.parsed).toBe(4);
    expect(sorted(again)).toEqual(sorted(fresh));
  });

  it("forgets files that are gone, and writes nothing when nothing changed", () => {
    read();
    rmSync(join(evidence, "other", "status.json"));
    read();
    const doc = JSON.parse(readFileSync(cacheFile, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(doc.entries).sort()).toEqual([
      join("local-reviews", "r1", "review.json"),
      join("local-reviews", "r1", "split.json"),
      join("other", "notes.json"),
    ]);
    rmSync(cacheFile);
    const cache = ReviewCache.load(cacheFile);
    cache.save();
    expect(existsSync(cacheFile)).toBe(false);
  });

  it("never keeps an entry it can't tell apart later", () => {
    const cache = ReviewCache.load(cacheFile);
    cache.set("x.json", null, null);
    cache.save();
    expect(ReviewCache.load(cacheFile).get("x.json", null)).toBeUndefined();
  });

  it("keeps one cache per evidence folder, in the checkout's node_modules, never a shared temp folder (Qodo on PR 278)", () => {
    const checkout = join(dir, "checkout");
    expect(defaultCacheFile(join(dir, "a"), checkout)).not.toBe(defaultCacheFile(join(dir, "b"), checkout));
    expect(defaultCacheFile(evidence, checkout).startsWith(join(checkout, "node_modules", ".cache"))).toBe(true);
  });

  it("never caches a review whose split.json could not be read, only one that could not be parsed (Qodo on PR 278)", () => {
    const split = join(evidence, "local-reviews", "r1", "split.json");
    rmSync(split);
    mkdirSync(split); // stat works, reading fails: as a file locked or briefly unreadable would
    expect(read().records[0]).toMatchObject({ complete: false });
    const again = read();
    expect(again.parsed).toBe(1);
    expect(again.records[0]).toMatchObject({ complete: false });

    rmSync(split, { recursive: true });
    writeFileSync(split, "{ not json");
    read();
    expect(read().parsed).toBe(0);
  });
});
