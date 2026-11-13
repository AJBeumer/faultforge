import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qodoReviewComment, run } from "./case-review.ts";

const CASE_ID = "FF-9003";
const COMMIT = "f".repeat(40);
const SHORT = COMMIT.slice(0, 7);
const REVIEW_URL = "https://github.com/Owner/target/pull/7#issuecomment-2";

/** The comment feeds review:wait saves: each a `gh api --paginate --slurp` text, an array of pages. */
function feeds(comments: object[]): string {
  return JSON.stringify({ pr: JSON.stringify([comments]), inline: "[[]]" });
}

const QODO_REVIEW = {
  user: { login: "qodo-code-review[bot]" },
  body: "<h3>Code Review by Qodo</h3>\n\nfindings",
  html_url: REVIEW_URL,
  updated_at: "2026-11-01T00:06:00Z",
};
const QODO_SUMMARY = { ...QODO_REVIEW, body: "<h3>PR Summary by Qodo</h3>", html_url: "summary-url" };

function fixture(opts: { comments?: object[]; reviewed?: boolean; savedPr?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "case-review-"));
  const groundTruthPath = join(root, "ground-truth.jsonl");
  const auditEventsPath = join(root, "audit-events.jsonl");
  writeFileSync(groundTruthPath, `${JSON.stringify({ caseId: CASE_ID, kind: "control", injectionCommit: COMMIT })}\n`);
  const events: object[] = [
    {
      eventId: "e1",
      type: "pr.opened",
      caseId: CASE_ID,
      at: "2026-11-01T00:00:00Z",
      pr: 7,
      qodoConfiguration: "qodo-v9",
    },
  ];
  if (opts.reviewed)
    events.push({ eventId: "e2", type: "review.recorded", caseId: CASE_ID, at: "2026-11-01T00:07:00Z" });
  writeFileSync(auditEventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const dir = join(root, "raw-artifacts", "reviews", "target-pr7");
  mkdirSync(dir, { recursive: true });
  const save = { repo: "Owner/target", pr: opts.savedPr ?? 7, headSha: COMMIT, state: "complete", findings: [] };
  writeFileSync(join(dir, `${SHORT}.review.json`), JSON.stringify(save));
  writeFileSync(join(dir, `${SHORT}.comments.latest.raw.json`), feeds(opts.comments ?? [QODO_SUMMARY, QODO_REVIEW]));
  const out: string[] = [];
  const err: string[] = [];
  const go = (dryRun = false) =>
    run(CASE_ID, {
      dryRun,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      now: () => "2026-11-01T01:00:00.000Z",
      groundTruthPath,
      auditEventsPath,
      reviewsDir: join(root, "raw-artifacts", "reviews"),
    });
  return { go, out, err, auditEventsPath };
}

describe("qodoReviewComment", () => {
  it("picks Qodo's review comment, not its summary or anyone else's", () => {
    const other = { ...QODO_REVIEW, user: { login: "someone" }, html_url: "other" };
    expect(qodoReviewComment(feeds([QODO_SUMMARY, QODO_REVIEW, other]))).toEqual({
      url: REVIEW_URL,
      updatedAt: "2026-11-01T00:06:00Z",
    });
    expect(qodoReviewComment(feeds([QODO_SUMMARY]))).toBeUndefined();
  });
});

describe("npm run case:review (#162)", () => {
  it("appends the review.recorded event case:build needs, from what review:wait saved", () => {
    const fx = fixture();
    expect(fx.go()).toBe(0);
    const lines = readFileSync(fx.auditEventsPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1) as string)).toMatchObject({
      type: "review.recorded",
      caseId: CASE_ID,
      pr: { repo: "Owner/target", number: 7, url: "https://github.com/Owner/target/pull/7" },
      review: {
        reviewer: "qodo-code-review[bot]",
        path: "pr-comments",
        configVersion: "qodo-v9",
        reviewedCommit: COMMIT,
        reviewedAt: "2026-11-01T00:06:00Z",
        url: REVIEW_URL,
      },
      state: "complete",
    });
  });

  it("writes nothing with --dry-run, and nothing when the case already has its review event", () => {
    const dry = fixture();
    const before = readFileSync(dry.auditEventsPath, "utf8");
    expect(dry.go(true)).toBe(0);
    expect(readFileSync(dry.auditEventsPath, "utf8")).toBe(before);
    const again = fixture({ reviewed: true });
    expect(again.go()).toBe(1);
  });

  it("refuses when the saved feed holds no review comment from Qodo", () => {
    const fx = fixture({ comments: [QODO_SUMMARY] });
    expect(fx.go()).toBe(2);
    expect(fx.err.join("\n")).toContain("no review comment from Qodo");
  });

  it("refuses a save for another pull request than the case's", () => {
    const fx = fixture({ savedPr: 8 });
    expect(fx.go()).toBe(2);
    expect(fx.err.join("\n")).toContain("on PR 7");
  });

  it("refuses to run while the audit log has an amendment problem", () => {
    const fx = fixture();
    appendFileSync(
      fx.auditEventsPath,
      `${JSON.stringify({ kind: "amendment", amends: "missing", reason: "r", evidence: "e" })}\n`,
    );
    expect(fx.go()).toBe(2);
    expect(fx.err.join("\n")).toContain("has problems");
  });
});

describe("npm run case:review: unfinished reviews, stale comments and how pr.opened names the PR (Qodo on PR 214)", () => {
  it("records an unfinished review that has no review comment, pointing at the PR", () => {
    const fx = fixture({ comments: [QODO_SUMMARY] });
    const dir = join(fx.auditEventsPath, "..", "raw-artifacts", "reviews", "target-pr7");
    const save = JSON.parse(readFileSync(join(dir, `${SHORT}.review.json`), "utf8"));
    writeFileSync(
      join(dir, `${SHORT}.review.json`),
      JSON.stringify({ ...save, state: "review incomplete", recordedAt: "2026-11-01T00:30:00.000Z" }),
    );
    expect(fx.go()).toBe(0);
    const event = JSON.parse(readFileSync(fx.auditEventsPath, "utf8").trim().split("\n").at(-1) as string);
    expect(event).toMatchObject({
      state: "review incomplete",
      review: { url: "https://github.com/Owner/target/pull/7", reviewedAt: "2026-11-01T00:30:00.000Z" },
    });
  });

  it("ignores a Qodo review comment last updated before this commit's push", () => {
    expect(qodoReviewComment(feeds([QODO_REVIEW]), "2026-11-01T00:10:00.000Z")).toBeUndefined();
    expect(qodoReviewComment(feeds([QODO_REVIEW]), "2026-11-01T00:05:59.123Z")).toEqual({
      url: REVIEW_URL,
      updatedAt: "2026-11-01T00:06:00Z",
    });
  });

  it("records an unfinished review whose comment feed was never saved", () => {
    const fx = fixture();
    const dir = join(fx.auditEventsPath, "..", "raw-artifacts", "reviews", "target-pr7");
    const save = JSON.parse(readFileSync(join(dir, `${SHORT}.review.json`), "utf8"));
    writeFileSync(
      join(dir, `${SHORT}.review.json`),
      JSON.stringify({ ...save, state: "timed out", recordedAt: "2026-11-01T00:30:00.000Z" }),
    );
    rmSync(join(dir, `${SHORT}.comments.latest.raw.json`));
    expect(fx.go()).toBe(0);
    const event = JSON.parse(readFileSync(fx.auditEventsPath, "utf8").trim().split("\n").at(-1) as string);
    expect(event).toMatchObject({ state: "timed out", review: { url: "https://github.com/Owner/target/pull/7" } });
  });

  it("refuses a complete review whose comment feed was never saved", () => {
    const fx = fixture();
    rmSync(
      join(fx.auditEventsPath, "..", "raw-artifacts", "reviews", "target-pr7", `${SHORT}.comments.latest.raw.json`),
    );
    expect(fx.go()).toBe(2);
  });

  it("ignores a comment from the push's own second that predates it", () => {
    expect(qodoReviewComment(feeds([QODO_REVIEW]), "2026-11-01T00:06:00.900Z")).toBeUndefined();
    expect(qodoReviewComment(feeds([QODO_REVIEW]), "2026-11-01T00:06:00.000Z")).toBeDefined();
  });

  it("uses the case's own PR's save when another PR's save of the same commit is found first", () => {
    const fx = fixture();
    const other = join(fx.auditEventsPath, "..", "raw-artifacts", "reviews", "target-pr10");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, `${SHORT}.review.json`),
      JSON.stringify({ repo: "Owner/target", pr: 10, headSha: COMMIT, state: "complete", findings: [] }),
    );
    expect(fx.go()).toBe(0);
    const event = JSON.parse(readFileSync(fx.auditEventsPath, "utf8").trim().split("\n").at(-1) as string);
    expect(event.pr.number).toBe(7);
  });

  it("reads the PR from pr.opened as a number, a string or an object, and refuses when it names none", () => {
    for (const [pr, code] of [
      [7, 0],
      ["7", 0],
      [{ number: 7 }, 0],
      [{ number: 8 }, 2],
      [undefined, 2],
    ] as const) {
      const fx = fixture();
      const lines = readFileSync(fx.auditEventsPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      lines[0].pr = pr;
      writeFileSync(fx.auditEventsPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      expect(fx.go(true)).toBe(code);
    }
  });
});
