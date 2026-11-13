import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMatchRule } from "./match-rule.ts";
import {
  type AskFn,
  findSavedReview,
  parseCliArgs,
  printReport,
  type RunOptions,
  run,
  type SavedFinding,
  toMatchFinding,
} from "./verdict.ts";

const TEMPLATE = {
  id: "idempotency-guard-bypass-v1",
  kind: "bug",
  summary: "x",
  file: "src/x.ts",
  find: "a",
  replace: "b",
  publish: { branch: "b", commitMessage: "m" },
  ticket: { title: "t", what: "w", criteria: ["c"] },
  match: { kindTerms: ["replay", "idempotency"] },
};

const GROUND_TRUTH_ENTRY = {
  caseId: "FF-0001",
  kind: "sabotage",
  templateId: "idempotency-guard-bypass-v1",
  injectedFile: "src/bookings/create.ts",
  injectedLines: [33, 33],
  injectionCommit: "c7ffd1540d6ae37e15450c8342d83dc8f866884f",
};

const MATCHING_FINDING: SavedFinding = {
  id: "qodo:1",
  file: "src/bookings/create.ts",
  lines: [33, 33],
  title: "Booking replays expose another user's data",
  category: "Security",
  description: "a replay problem",
};

const OTHER_FINDING: SavedFinding = {
  id: "qodo:2",
  file: "src/other.ts",
  lines: [5, 6],
  title: "Unrelated nit",
  category: "Style",
  description: "something else entirely",
};

/** A private storage folder with a ground-truth file, a template and (optionally) a saved review. */
function fixture(
  opts: {
    entries?: unknown[];
    findings?: unknown[];
    noReview?: boolean;
    state?: string;
    withMalformedReview?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "verdict-"));
  const entries = opts.entries ?? [GROUND_TRUTH_ENTRY];
  writeFileSync(join(root, "ground-truth.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  writeFileSync(join(root, "audit-events.jsonl"), "");
  mkdirSync(join(root, "templates", TEMPLATE.id), { recursive: true });
  writeFileSync(join(root, "templates", TEMPLATE.id, "template.json"), JSON.stringify(TEMPLATE));
  if (opts.withMalformedReview) {
    // Sorts before "target-pr1", so the scan meets it first.
    const badDir = join(root, "raw-artifacts", "reviews", "other-pr1");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "bad.review.json"), "{ not json");
  }
  if (!opts.noReview) {
    const reviewDir = join(root, "raw-artifacts", "reviews", "target-pr1");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, "c7ffd154.review.json"),
      JSON.stringify({
        repo: "AJBeumer/faultforge-target",
        pr: 1,
        headSha: GROUND_TRUTH_ENTRY.injectionCommit,
        state: opts.state ?? "complete",
        findings: opts.findings ?? [MATCHING_FINDING],
      }),
    );
  }
  return root;
}

/** A fake prompt that returns each of `answers` in turn, recording every question asked. */
function fakeAsk(answers: string[]): { ask: AskFn; questions: string[] } {
  const questions: string[] = [];
  let i = 0;
  const ask: AskFn = async (question: string) => {
    questions.push(question);
    const answer = answers[i];
    i++;
    return answer ?? "";
  };
  return { ask, questions };
}

function runOn(caseId: string, root: string, extra: Partial<RunOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const appended: object[] = [];
  const options: RunOptions = {
    env: { FAULTFORGE_PRIVATE_DIR: root },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    isTTY: true,
    ownerLogin: () => "AJBeumer",
    now: () => "2026-11-10T12:00:00.000Z",
    append: (_path, value) => appended.push(value),
    ...extra,
  };
  return run(caseId, options).then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), appended }));
}

describe("toMatchFinding", () => {
  it("maps a saved finding's description to summary, defaulting missing fields to null", () => {
    expect(toMatchFinding({ id: "a", file: null, lines: null })).toEqual({
      id: "a",
      file: null,
      lines: null,
      title: null,
      summary: null,
      category: null,
    });
    expect(toMatchFinding(MATCHING_FINDING)).toEqual({
      id: "qodo:1",
      file: "src/bookings/create.ts",
      lines: [33, 33],
      title: "Booking replays expose another user's data",
      summary: "a replay problem",
      category: "Security",
    });
  });
});

describe("findSavedReview", () => {
  it("finds the review.json whose headSha matches, across subfolders", () => {
    const root = fixture();
    const found = findSavedReview(join(root, "raw-artifacts", "reviews"), GROUND_TRUTH_ENTRY.injectionCommit);
    expect(found?.review.headSha).toBe(GROUND_TRUTH_ENTRY.injectionCommit);
  });

  it("is undefined when no file matches, or the directory can't be read", () => {
    const root = fixture();
    expect(
      findSavedReview(join(root, "raw-artifacts", "reviews"), "0000000000000000000000000000000000000000"),
    ).toBeUndefined();
    expect(findSavedReview(join(root, "no-such-dir"), "anything")).toBeUndefined();
  });
});

describe("printReport", () => {
  it("prints each finding's criteria, range, width, category and summary, then the catch", () => {
    const findings = [MATCHING_FINDING].map(toMatchFinding);
    const result = applyMatchRule({ file: "src/bookings/create.ts", lines: [33, 33] }, findings, [
      "replay",
      "idempotency",
    ]);
    const out: string[] = [];
    printReport((l) => out.push(l), findings, result);
    const text = out.join("\n");
    expect(text).toContain("file: PASS");
    expect(text).toContain("lines: PASS");
    expect(text).toContain("kind: PASS");
    expect(text).toContain("lines 33-33, 1 line");
    expect(text).toContain("category: Security");
    expect(text).toContain("summary: a replay problem");
    expect(text).toContain("caught: true");
  });
});

describe("npm run verdict: the no-terminal path", () => {
  it("prints the match, writes nothing, and exits 1 when stdin is not a TTY", async () => {
    const root = fixture();
    const { ask } = fakeAsk([]);
    const { code, out, appended } = await runOn("FF-0001", root, { isTTY: false, ask });
    expect(code).toBe(1);
    expect(out).toContain("caught: true");
    expect(out).toContain("no terminal to ask on");
    expect(appended).toEqual([]);
  });
});

describe("npm run verdict: what it refuses with exit 2", () => {
  it("a case id with no ground-truth entry", async () => {
    const root = fixture();
    const { code, err } = await runOn("FF-9999", root, { isTTY: false });
    expect(code).toBe(2);
    expect(err).toMatch(/no ground-truth entry for FF-9999/);
  });

  it("a case with no saved review.json for its injected commit", async () => {
    const root = fixture({ noReview: true });
    const { code, err } = await runOn("FF-0001", root, { isTTY: false });
    expect(code).toBe(2);
    expect(err).toMatch(/no saved review\.json for commit/);
  });

  it("a template that can't be found", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "ground-truth.jsonl"),
      `${JSON.stringify({ ...GROUND_TRUTH_ENTRY, templateId: "no-such-template" })}\n`,
    );
    const { code, err } = await runOn("FF-0001", root, { isTTY: false });
    expect(code).toBe(2);
    expect(err).toMatch(/template no-such-template not found/);
  });

  it("an invalid answer for the planted bug's verdict, after retrying, and nothing is appended", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["nonsense", "nope", "still no"]);
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toMatch(/no valid answer \(detected, missed or review incomplete\)/);
    expect(appended).toEqual([]);
  });

  it("an invalid judgement for another finding, after retrying", async () => {
    const root = fixture({ findings: [MATCHING_FINDING, OTHER_FINDING] });
    const { ask } = fakeAsk(["detected", "caught it", "nonsense", "nope", "still no"]);
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toMatch(/no valid answer \(real, false alarm or open\) for finding qodo:2/);
    expect(appended).toEqual([]);
  });
});

describe("npm run verdict: the event it appends", () => {
  it("has the case id, commit, owner, time, disposition and reason, with no other findings to judge", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "Qodo named the file and the lines, describing the replay bug"]);
    const { code, out, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(0);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "case.adjudicated",
      caseId: "FF-0001",
      commit: GROUND_TRUTH_ENTRY.injectionCommit,
      by: "AJBeumer",
      at: "2026-11-10T12:00:00.000Z",
      disposition: "confirmed_detected",
      reason: "Qodo named the file and the lines, describing the replay bug",
      judgements: [],
    });
    expect(out).toContain("recorded: FF-0001 confirmed_detected");
  });

  it("records a real judgement and an open one (blank) for the two other findings; a blank answer asks for no reason", async () => {
    const root = fixture({ findings: [MATCHING_FINDING, OTHER_FINDING, { ...OTHER_FINDING, id: "qodo:3" }] });
    const { ask, questions } = fakeAsk([
      "detected",
      "it matched",
      "real",
      "looks like a genuine nit",
      "", // the blank judgement: unjudged, stays open, asked for no reason
    ]);
    const { code, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(0);
    const event = appended[0] as { judgements: { id: string; verdict: string; reason: string }[] };
    expect(event.judgements).toEqual([
      { id: "qodo:2", verdict: "real", reason: "looks like a genuine nit" },
      { id: "qodo:3", verdict: "open", reason: "" },
    ]);
    // Five questions asked: the bug verdict, its reason, qodo:2's judgement, its reason, qodo:3's judgement —
    // no sixth "Reason:" question for the blank (unjudged) qodo:3.
    expect(questions).toHaveLength(5);
  });

  it("maps each disposition word, case-insensitively, to the schema's enum value", async () => {
    // The fixture's finding is a catch, so "missed" contradicts the rule and is confirmed first (#192).
    for (const [word, answers, disposition] of [
      ["DETECTED", ["reason"], "confirmed_detected"],
      ["missed", ["yes", "reason"], "confirmed_missed"],
      ["Review Incomplete", ["reason"], "review_incomplete"],
    ] as const) {
      const root = fixture();
      const { ask } = fakeAsk([word, ...answers]);
      const { appended } = await runOn("FF-0001", root, { ask });
      expect(appended[0]).toMatchObject({ disposition });
    }
  });

  it("asks before recording an answer the rule contradicts, and writes nothing without a yes (#192)", async () => {
    const refused = await runOn("FF-0001", fixture(), { ask: fakeAsk(["missed", "no"]).ask });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("contradicts the rule");
    expect(refused.appended).toEqual([]);
    const { ask, questions } = fakeAsk(["detected", "agrees with the rule"]);
    const agreed = await runOn("FF-0001", fixture(), { ask });
    expect(agreed.code).toBe(0);
    expect(questions.some((q) => q.includes("Record it anyway"))).toBe(false);
  });

  it("refuses to run while the answer key has an amendment that changes a locked field (#192)", async () => {
    const root = fixture();
    const groundTruth = join(root, "ground-truth.jsonl");
    appendFileSync(
      groundTruth,
      `${JSON.stringify({ kind: "amendment", amends: "FF-0001", change: { caseId: "FF-9" }, reason: "r", evidence: "e" })}\n`,
    );
    const { code, err, appended } = await runOn("FF-0001", root, { ask: fakeAsk(["detected", "r"]).ask });
    expect(code).toBe(2);
    expect(err).toContain("changes caseId");
    expect(appended).toEqual([]);
  });

  it("with --dry-run, prints the event and appends nothing", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "a reason"]);
    const appendCalls: object[] = [];
    const { code, out } = await runOn("FF-0001", root, {
      ask,
      dryRun: true,
      append: (_p, v) => appendCalls.push(v),
    });
    expect(code).toBe(0);
    expect(appendCalls).toEqual([]);
    expect(out).toContain("(dry run) would append");
    expect(out).toContain('"type": "case.adjudicated"');
  });

  it("refuses to determine the owner's login", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "a reason"]);
    const { code, err, appended } = await runOn("FF-0001", root, {
      ask,
      ownerLogin: () => {
        throw new Error("gh: not authenticated");
      },
    });
    expect(code).toBe(2);
    expect(err).toMatch(/can't determine the owner's login/);
    expect(appended).toEqual([]);
  });
});

describe("npm run verdict: review findings", () => {
  it("refuses a blank reason for the planted bug's verdict, after retrying, and appends nothing", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "", "  ", ""]);
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toMatch(/no reason given for the planted bug's verdict/);
    expect(appended).toEqual([]);
  });

  it("refuses a blank reason for an explicit (non-open) finding judgement, after retrying", async () => {
    const root = fixture({ findings: [MATCHING_FINDING, OTHER_FINDING] });
    const { ask } = fakeAsk(["detected", "it matched", "real", "", "  ", ""]);
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toMatch(/no reason given for finding qodo:2's judgement/);
    expect(appended).toEqual([]);
  });

  it("warns when the saved review's state is not complete, and only accepts review incomplete", async () => {
    const root = fixture({ state: "skipped by Qodo" });
    const { ask } = fakeAsk(["detected", "missed", "review incomplete", "the review was skipped"]);
    const { code, out, appended } = await runOn("FF-0001", root, { ask });
    expect(out).toMatch(/WARNING.*skipped by Qodo/);
    expect(code).toBe(0);
    expect(appended[0]).toMatchObject({ disposition: "review_incomplete" });
  });

  it("refuses a --review file reviewing a different commit than the case's injection", async () => {
    const root = fixture();
    const otherReviewPath = join(root, "other.review.json");
    writeFileSync(
      otherReviewPath,
      JSON.stringify({ headSha: "0000000000000000000000000000000000000000", findings: [MATCHING_FINDING] }),
    );
    const { ask } = fakeAsk([]);
    const { code, err, appended } = await runOn("FF-0001", root, {
      ask,
      isTTY: false,
      reviewPath: otherReviewPath,
    });
    expect(code).toBe(2);
    expect(err).toMatch(/reviewed 0{40}, not FF-0001's injected commit/);
    expect(appended).toEqual([]);
  });

  it("skips a malformed review.json in another case's directory instead of crashing the scan", async () => {
    const root = fixture({ withMalformedReview: true });
    const found = findSavedReview(join(root, "raw-artifacts", "reviews"), GROUND_TRUTH_ENTRY.injectionCommit);
    expect(found?.review.headSha).toBe(GROUND_TRUTH_ENTRY.injectionCommit);
    const { code } = await runOn("FF-0001", root, { isTTY: false });
    expect(code).toBe(1); // got past discovery; stopped only at the no-terminal path
  });

  it("records an inputHash so the event's exact inputs can be checked later", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "a reason"]);
    const { appended } = await runOn("FF-0001", root, { ask });
    const event = appended[0] as { inputHash?: string };
    expect(event.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 2 instead of throwing when appending the event fails", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "a reason"]);
    const { code, err } = await runOn("FF-0001", root, {
      ask,
      append: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    expect(code).toBe(2);
    expect(err).toMatch(/can't append.*ENOSPC/);
  });
});

describe("parseCliArgs", () => {
  it("accepts a bare case id, --dry-run and --review <path>", () => {
    expect(parseCliArgs(["FF-0001"])).toEqual({ caseId: "FF-0001", dryRun: false, reviewPath: undefined });
    expect(parseCliArgs(["FF-0001", "--dry-run"])).toEqual({ caseId: "FF-0001", dryRun: true, reviewPath: undefined });
    expect(parseCliArgs(["FF-0001", "--review", "/tmp/r.json"])).toEqual({
      caseId: "FF-0001",
      dryRun: false,
      reviewPath: "/tmp/r.json",
    });
  });

  it("is null with no case id, or a --review with no path", () => {
    expect(parseCliArgs([])).toBeNull();
    expect(parseCliArgs(["FF-0001", "--review"])).toBeNull();
  });
});
