import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventProblems } from "./ledger-append.ts";
import { applyMatchRule } from "./match-rule.ts";
import { findSavedReview, type SavedFinding, toMatchFinding } from "./saved-review.ts";
import { type AskFn, parseCliArgs, printReport, type RunOptions, run } from "./verdict.ts";
import { latestVerdict, normalReason, reasonsOfOtherCases } from "./verdict-event.ts";

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
  // Each case's PR, which is how verdict finds the save it judges.
  const opened = (entries as { caseId: string }[]).map((e) =>
    JSON.stringify({
      eventId: `${e.caseId}-pr`,
      type: "pr.opened",
      at: "2026-11-10T11:00:00.000Z",
      caseId: e.caseId,
      pr: 1,
    }),
  );
  writeFileSync(join(root, "audit-events.jsonl"), opened.map((l) => `${l}\n`).join(""));
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
    const { ask } = fakeAsk(["detected", "caught it", "real", "the planted bug", "nonsense", "nope", "still no"]);
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toMatch(/no valid answer \(real, false alarm or open\) for finding qodo:2/);
    expect(appended).toEqual([]);
  });
});

describe("npm run verdict: the event it appends", () => {
  it("has the case id, commit, owner, time, disposition and reason, and the matched finding's judgement", async () => {
    const root = fixture();
    const { ask } = fakeAsk([
      "detected",
      "Qodo named the file and the lines, describing the replay bug",
      "real",
      "it is the planted bug",
    ]);
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
      judgements: [{ id: "qodo:1", verdict: "real", reason: "it is the planted bug" }],
    });
    expect(appended[0]).not.toHaveProperty("supersedes");
    expect(out).toContain("recorded: FF-0001 confirmed_detected");
  });

  it("records a real judgement and an open one (blank) for the two other findings; a blank answer asks for no reason", async () => {
    const root = fixture({ findings: [MATCHING_FINDING, OTHER_FINDING, { ...OTHER_FINDING, id: "qodo:3" }] });
    const { ask, questions } = fakeAsk([
      "detected",
      "it matched",
      "real",
      "the planted bug",
      "real",
      "looks like a genuine nit",
      "", // the blank judgement: unjudged, stays open, asked for no reason
    ]);
    const { code, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(0);
    const event = appended[0] as { judgements: { id: string; verdict: string; reason: string }[] };
    expect(event.judgements).toEqual([
      { id: "qodo:1", verdict: "real", reason: "the planted bug" },
      { id: "qodo:2", verdict: "real", reason: "looks like a genuine nit" },
      { id: "qodo:3", verdict: "open", reason: "" },
    ]);
    // Seven questions asked: the bug verdict, its reason, qodo:1's and qodo:2's judgements and reasons, and
    // qodo:3's judgement — no eighth "Reason:" question for the blank (unjudged) qodo:3.
    expect(questions).toHaveLength(7);
  });

  it("maps each disposition word, case-insensitively, to the schema's enum value", async () => {
    // The fixture's finding is a catch, so "missed" contradicts the rule and is confirmed first (#192).
    for (const [word, answers, disposition] of [
      ["DETECTED", ["reason", "real", "r"], "confirmed_detected"],
      ["missed", ["yes", "reason", "false alarm", "r"], "confirmed_missed"],
      ["Review Incomplete", ["reason", "real", "r"], "review_incomplete"],
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
    const { ask, questions } = fakeAsk(["detected", "agrees with the rule", "real", "r"]);
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
    const { ask } = fakeAsk(["detected", "a reason", "real", "r"]);
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
    const { ask } = fakeAsk(["detected", "a reason", "real", "r"]);
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
    const { ask } = fakeAsk(["detected", "it matched", "real", "the bug", "real", "", "  ", ""]);
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toMatch(/no reason given for finding qodo:2's judgement/);
    expect(appended).toEqual([]);
  });

  it("warns when the saved review's state is not complete, and only accepts review incomplete", async () => {
    const root = fixture({ state: "skipped by Qodo" });
    const { ask } = fakeAsk(["detected", "missed", "review incomplete", "the review was skipped", "real", "r"]);
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
    const { ask } = fakeAsk(["detected", "a reason", "real", "r"]);
    const { appended } = await runOn("FF-0001", root, { ask });
    const event = appended[0] as { inputHash?: string };
    expect(event.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 2 instead of throwing when appending the event fails", async () => {
    const root = fixture();
    const { ask } = fakeAsk(["detected", "a reason", "real", "r"]);
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

describe("npm run verdict: a control case, whose template declares no match terms (#162)", () => {
  // A control template as template.v2.json requires it: no invariantId, defectClass, proofTest or match.
  const CONTROL_TEMPLATE = {
    schemaVersion: 2,
    id: "example-control-v1",
    kind: "control",
    summary: "An ordinary, harmless change, used as a control case.",
    file: "src/bookings/create.ts",
    find: "a",
    replace: "b",
    publish: { branch: "b", commitMessage: "m" },
    ticket: { title: "t", what: "w", criteria: ["c"] },
  };
  const CONTROL_ENTRY = {
    caseId: "FF-0002",
    kind: "control",
    templateId: CONTROL_TEMPLATE.id,
    injectedFile: "src/bookings/create.ts",
    injectedLines: [33, 33],
    injectionCommit: GROUND_TRUTH_ENTRY.injectionCommit,
  };

  function controlFixture(opts: { findings?: unknown[]; state?: string } = {}) {
    const root = fixture({ entries: [CONTROL_ENTRY], findings: opts.findings ?? [], state: opts.state });
    mkdirSync(join(root, "templates", CONTROL_TEMPLATE.id), { recursive: true });
    writeFileSync(join(root, "templates", CONTROL_TEMPLATE.id, "template.json"), JSON.stringify(CONTROL_TEMPLATE));
    return root;
  }

  it("records a control Qodo raised nothing on as confirmed_clean, without reading match terms", async () => {
    const { ask, questions } = fakeAsk(["clean", "Qodo reviewed the change and raised nothing"]);
    const { code, err, appended } = await runOn("FF-0002", controlFixture(), { ask });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(questions[0]).toBe("Verdict on the control (clean/review incomplete): ");
    expect(appended[0]).toMatchObject({ disposition: "confirmed_clean", judgements: [] });
  });

  it("refuses a false alarm while a finding is left open (Qodo on PR 214)", async () => {
    const { ask } = fakeAsk(["false alarm", "harmless change", ""]);
    const { code, err, appended } = await runOn("FF-0002", controlFixture({ findings: [OTHER_FINDING] }), { ask });
    expect(code).toBe(2);
    expect(err).toContain("left open");
    expect(appended).toEqual([]);
  });

  it("records a control with a finding as a false alarm, with every finding judged", async () => {
    const { ask, questions } = fakeAsk(["false alarm", "harmless change", "false alarm", "nothing changed there"]);
    const { code, out, appended } = await runOn("FF-0002", controlFixture({ findings: [MATCHING_FINDING] }), { ask });
    expect(code).toBe(0);
    expect(questions[0]).toBe("Verdict on the control (false alarm/review incomplete): ");
    expect(out).not.toMatch(/caught:|matched:/);
    expect(appended[0]).toMatchObject({
      disposition: "confirmed_false_alarm",
      judgements: [{ id: "qodo:1", verdict: "false alarm", reason: "nothing changed there" }],
    });
  });

  it("refuses to record a control whose finding the owner judges real: it wasn't clean", async () => {
    const { ask } = fakeAsk(["false alarm", "r", "real", "it is a real problem"]);
    const { code, err, appended } = await runOn("FF-0002", controlFixture({ findings: [OTHER_FINDING] }), { ask });
    expect(code).toBe(2);
    expect(err).toContain("judged real");
    expect(appended).toEqual([]);
  });

  it("refuses detected or missed for a control, and clean when Qodo raised something", async () => {
    const words = await runOn("FF-0002", controlFixture(), { ask: fakeAsk(["detected", "missed", "detected"]).ask });
    expect(words.code).toBe(2);
    expect(words.err).toContain("no valid answer (clean or review incomplete)");
    const clean = await runOn("FF-0002", controlFixture({ findings: [OTHER_FINDING] }), {
      ask: fakeAsk(["clean", "clean", "clean"]).ask,
    });
    expect(clean.code).toBe(2);
    expect(clean.appended).toEqual([]);
  });

  it("offers a control only review incomplete when the saved review didn't finish", async () => {
    const root = controlFixture({ state: "skipped by Qodo" });
    expect((await runOn("FF-0002", root, { ask: fakeAsk(["clean", "clean", "clean"]).ask })).code).toBe(2);
    const { code, appended } = await runOn("FF-0002", root, { ask: fakeAsk(["review incomplete", "skipped"]).ask });
    expect(code).toBe(0);
    expect(appended[0]).toMatchObject({ disposition: "review_incomplete" });
  });
});

describe("npm run verdict: the save it judges (#244, AUD-M1, AUD-M24)", () => {
  /** A second save of the same commit, on PR 2. */
  function addSaveOnPr2(root: string, review: Record<string, unknown>) {
    const dir = join(root, "raw-artifacts", "reviews", "target-pr2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "c7ffd15.review.json"),
      JSON.stringify({ pr: 2, headSha: GROUND_TRUTH_ENTRY.injectionCommit, ...review }),
    );
  }

  it("finds the save by the case's own PR, never another PR's save of the same commit", async () => {
    const root = fixture({ findings: [] });
    addSaveOnPr2(root, { state: "complete", findings: [MATCHING_FINDING] });
    appendFileSync(
      join(root, "audit-events.jsonl"),
      `${JSON.stringify({ eventId: "later-pr", type: "pr.opened", at: "2026-11-10T11:30:00.000Z", caseId: "FF-0001", pr: { number: 2 } })}\n`,
    );
    const { ask } = fakeAsk(["detected", "found it", "real", "r"]);
    const { code, out, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(0);
    expect(out).toContain("caught: true");
    expect(appended[0]).toMatchObject({ disposition: "confirmed_detected", ruleVersion: "1" });
  });

  it("refuses, exit 2, a case whose PR no event names", async () => {
    const root = fixture();
    writeFileSync(join(root, "audit-events.jsonl"), "");
    const { code, err } = await runOn("FF-0001", root, { ask: fakeAsk([]).ask });
    expect(code).toBe(2);
    expect(err).toContain("no pr.opened event naming its PR");
  });

  it("reads a save with no state as unfinished: only review incomplete is offered (M60)", async () => {
    const root = fixture({ findings: [] });
    const path = join(root, "raw-artifacts", "reviews", "target-pr1", "c7ffd154.review.json");
    const { state: _gone, ...rest } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(rest));
    const { ask } = fakeAsk(["missed", "missed", "missed"]);
    const { code, out, appended } = await runOn("FF-0001", root, { ask });
    expect(out).toContain("WARNING: the saved review's state is null");
    expect(code).toBe(2);
    expect(appended).toEqual([]);
  });

  it("refuses, exit 2, a save with no findings list rather than read it as none (M61)", async () => {
    const root = fixture();
    const path = join(root, "raw-artifacts", "reviews", "target-pr1", "c7ffd154.review.json");
    const { findings: _gone, ...rest } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(rest));
    const { code, err, appended } = await runOn("FF-0001", root, { ask: fakeAsk(["missed", "x"]).ask });
    expect(code).toBe(2);
    expect(err).toContain("holds no findings list");
    expect(appended).toEqual([]);
  });
});

describe("npm run verdict: a reason belongs to its case, every match is judged, a repeat supersedes (#250, AUD-H4)", () => {
  const verdictLine = (fields: Record<string, unknown>) =>
    `${JSON.stringify({ type: "case.adjudicated", at: "2026-11-10T11:50:00.000Z", disposition: "confirmed_detected", ...fields })}\n`;

  it("refuses a reason already given for another case's verdict, however it is spaced or capitalised", async () => {
    const root = fixture();
    appendFileSync(
      join(root, "audit-events.jsonl"),
      verdictLine({ eventId: "other", caseId: "FF-0002", reason: "Finding names the injected lines." }),
    );
    const same = [
      "finding names  the injected lines",
      "FINDING NAMES THE INJECTED LINES.",
      "Finding names the injected lines",
    ];
    const refused = await runOn("FF-0001", root, { ask: fakeAsk(["detected", ...same]).ask });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("same as another case's verdict");
    expect(refused.appended).toEqual([]);
    const own = await runOn("FF-0001", root, {
      ask: fakeAsk(["detected", "Finding names the injected lines.", "Qodo named the replayed booking", "real", "r"])
        .ask,
    });
    expect(own.code).toBe(0);
    expect(own.appended[0]).toMatchObject({ reason: "Qodo named the replayed booking" });
  });

  it("an amended reason of another case counts as taken too", async () => {
    const root = fixture();
    appendFileSync(join(root, "audit-events.jsonl"), verdictLine({ eventId: "other", caseId: "FF-0002", reason: "x" }));
    appendFileSync(
      join(root, "audit-events.jsonl"),
      `${JSON.stringify({ kind: "amendment", amends: "other", at: "2026-11-10T11:55:00.000Z", change: { amendedReason: "A later reason" }, reason: "r", evidence: "e" })}\n`,
    );
    const { code } = await runOn("FF-0001", root, { ask: fakeAsk(["detected", "a later reason", "", ""]).ask });
    expect(code).toBe(2);
  });

  it("blocks the verdict while a finding the rule matched is left unjudged", async () => {
    const root = fixture();
    const { code, err, appended } = await runOn("FF-0001", root, {
      ask: fakeAsk(["detected", "Qodo found it", "", "open", "later"]).ask,
    });
    expect(code).toBe(2);
    expect(err).toContain("finding qodo:1 matched the rule and was not judged real or a false alarm");
    expect(appended).toEqual([]);
  });

  it("refuses a repeat verdict without --supersede naming the latest one, and records it when named", async () => {
    const root = fixture();
    appendFileSync(
      join(root, "audit-events.jsonl"),
      verdictLine({ eventId: "old-verdict", caseId: "FF-0001", reason: "x" }),
    );
    const answers = () => fakeAsk(["detected", "Qodo found the replay", "real", "r"]).ask;
    const plain = await runOn("FF-0001", root, { ask: answers() });
    expect(plain.code).toBe(2);
    expect(plain.err).toContain("--supersede old-verdict");
    expect(plain.appended).toEqual([]);
    const wrong = await runOn("FF-0001", root, { ask: answers(), supersede: "another" });
    expect(wrong.code).toBe(2);
    const named = await runOn("FF-0001", root, { ask: answers(), supersede: "old-verdict" });
    expect(named.code).toBe(0);
    expect(named.appended[0]).toMatchObject({ supersedes: "old-verdict" });
  });

  it("refuses --supersede when there is no verdict to supersede", async () => {
    const { code, err } = await runOn("FF-0001", fixture(), { ask: fakeAsk([]).ask, supersede: "x" });
    expect(code).toBe(2);
    expect(err).toContain("has no verdict to supersede");
  });

  it("reads --supersede from the command line", () => {
    expect(parseCliArgs(["FF-0001", "--supersede", "abc"])).toMatchObject({ caseId: "FF-0001", supersede: "abc" });
  });
});

describe("npm run verdict: its event fits the audit-event schema (#251)", () => {
  it("passes appendEvent's check for a bug case and a control", async () => {
    const bug = await runOn("FF-0001", fixture(), { ask: fakeAsk(["detected", "Qodo named it", "real", "r"]).ask });
    expect(eventProblems(bug.appended[0])).toEqual([]);
  });
});

describe("npm run verdict: what Qodo found on PR 267", () => {
  const verdictLine = (fields: Record<string, unknown>) =>
    `${JSON.stringify({ type: "case.adjudicated", caseId: "FF-0001", disposition: "confirmed_detected", reason: "x", ...fields })}\n`;

  it("refuses detected when no matched finding is judged real, and missed when one is", async () => {
    const detected = await runOn("FF-0001", fixture(), { ask: fakeAsk(["detected", "found", "false alarm", "r"]).ask });
    expect(detected.code).toBe(2);
    expect(detected.err).toContain("no finding that could be the catch is judged real");
    const missed = await runOn("FF-0001", fixture(), { ask: fakeAsk(["missed", "yes", "nope", "real", "r"]).ask });
    expect(missed.code).toBe(2);
    expect(missed.err).toContain("a finding the rule matched is judged real");
  });

  it("supersedes the latest verdict by time, as case:build picks it, not the last line", async () => {
    const root = fixture();
    appendFileSync(join(root, "audit-events.jsonl"), verdictLine({ eventId: "later", at: "2026-11-10T11:59:00.000Z" }));
    appendFileSync(
      join(root, "audit-events.jsonl"),
      verdictLine({ eventId: "earlier", at: "2026-11-10T11:50:00.000Z" }),
    );
    const { code, err } = await runOn("FF-0001", root, { ask: fakeAsk([]).ask, supersede: "earlier" });
    expect(code).toBe(2);
    expect(err).toContain("isn't FF-0001's latest verdict, later");
  });

  it("writes nothing when another verdict was recorded while the owner answered", async () => {
    const root = fixture();
    let n = 0;
    const ask = async () => {
      if (n === 0)
        appendFileSync(
          join(root, "audit-events.jsonl"),
          verdictLine({ eventId: "rival", at: "2026-11-10T11:58:00.000Z" }),
        );
      return ["detected", "found it", "real", "r"][n++] ?? "";
    };
    const { code, err, appended } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toContain("recorded meanwhile");
    expect(appended).toEqual([]);
  });

  it("counts a reason an amendment later replaced as still taken", () => {
    const events = [
      {
        type: "case.adjudicated",
        caseId: "FF-0002",
        reason: "a",
        amendedReason: "second",
        amendments: [{ change: { amendedReason: "first" } }, { change: { amendedReason: "second" } }],
      },
    ];
    expect(reasonsOfOtherCases(events, "FF-0001")).toEqual(new Set(["a", "second", "first"]));
  });
});

describe("npm run verdict: round two on PR 267", () => {
  it("lets the owner overrule a computed miss, with an unmatched finding judged real", async () => {
    const root = fixture({ findings: [{ ...OTHER_FINDING }] });
    const { code, appended } = await runOn("FF-0001", root, {
      ask: fakeAsk(["detected", "yes", "Qodo described it on the wrong line", "real", "that is the bug"]).ask,
    });
    expect(code).toBe(0);
    expect(appended[0]).toMatchObject({ disposition: "confirmed_detected" });
  });

  it("refuses to supersede a verdict that has no event id", async () => {
    const root = fixture();
    appendFileSync(
      join(root, "audit-events.jsonl"),
      `${JSON.stringify({ type: "case.adjudicated", caseId: "FF-0001", at: "2026-11-10T11:50:00.000Z", disposition: "x" })}\n`,
    );
    const { code, err } = await runOn("FF-0001", root, { ask: fakeAsk([]).ask });
    expect(code).toBe(2);
    expect(err).toContain("has no event id");
  });

  it("writes nothing when another case took the same reason while the owner answered", async () => {
    const root = fixture();
    let n = 0;
    const ask = async () => {
      if (n === 3) {
        appendFileSync(
          join(root, "audit-events.jsonl"),
          `${JSON.stringify({ eventId: "o", type: "case.adjudicated", caseId: "FF-0002", at: "2026-11-10T11:59:00.000Z", reason: "found it" })}\n`,
        );
      }
      return ["detected", "found it", "real", "r"][n++] ?? "";
    };
    const { code, err } = await runOn("FF-0001", root, { ask });
    expect(code).toBe(2);
    expect(err).toContain("same reason meanwhile");
  });
});

describe("npm run verdict: round three on PR 267", () => {
  it("reads a reason the same whatever spacing or full stops close it", () => {
    for (const r of ["Same reason .", "same reason..", "  SAME   reason  "])
      expect(normalReason(r)).toBe("same reason");
  });

  it("refuses a save with two findings of one id, and a verdict with no readable time", async () => {
    const dup = await runOn("FF-0001", fixture({ findings: [MATCHING_FINDING, MATCHING_FINDING] }), {
      ask: fakeAsk([]).ask,
    });
    expect(dup.code).toBe(2);
    expect(dup.err).toContain("two findings with the same id");
    expect(() => latestVerdict([{ type: "case.adjudicated", eventId: "a", at: "soon" }])).toThrow(/no readable time/);
  });
});

describe("verdict: the case id is checked before it names a file (#299)", () => {
  it.each(["../x", "FF-12", "ff-0002", "FF-0002/../../x", "FF-00020"])(
    "refuses %s with exit 2 and reads nothing",
    async (id) => {
      const dir = mkdtempSync(join(tmpdir(), "verdict-id-"));
      const errors: string[] = [];
      const code = await run(id, {
        auditEventsPath: join(dir, "missing-audit.jsonl"),
        groundTruthPath: join(dir, "missing-gt.jsonl"),
        error: (line) => errors.push(line),
        log: () => {},
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toMatch(/a case id is FF- and four digits/);
    },
  );
});
