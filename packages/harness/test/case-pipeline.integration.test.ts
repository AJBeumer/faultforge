/**
 * The case pipeline end to end, on fixtures (#229): `inject` plants a case in a scratch copy of the target and
 * records it in a scratch private folder; a saved review stands in for `review:wait`; then `case:review`,
 * `verdict` (its questions answered by a script, as the owner would) and `case:build` run as they do for a
 * real case. Covers a bug case, a clean control and a control whose review didn't finish. Needs the target
 * checkout next to this repository, so it is skipped where there is none.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run as buildCase } from "../src/case-build.ts";
import { validateCaseRecord } from "../src/case-record.ts";
import { run as reviewCase } from "../src/case-review.ts";
import { readLedger } from "../src/ledger.ts";
import { run as verdict } from "../src/verdict.ts";

const root = resolve(import.meta.dirname, "../../..");
const realTarget = resolve(root, "../faultforge-target");
const hasRealTarget = existsSync(join(realTarget, "package.json"));
const REPO = "AJBeumer/faultforge-target";

const scratch: string[] = [];
// Each scratch target holds a full node_modules. Deleting them takes longer than Vitest's 10 s hook default on
// a Windows runner, and Windows can briefly hold a file open, so retry and allow two minutes.
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 120_000);
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

/** A control written for this test only: a rename in `listBookings`, behaviour unchanged. */
const CONTROL_TEMPLATE = {
  $schema: "../../../schemas/template.v2.json",
  schemaVersion: 2,
  id: "pipeline-rename-v1",
  kind: "control",
  summary: "Control for the pipeline test: a local variable renamed. Behaviour unchanged.",
  file: "src/bookings/list.ts",
  find: '  const created = deps.store.listBookings(userId);\n  const filtered = status.kind === "value" ? created.filter((booking) => booking.status === status.value) : created;\n',
  replace:
    '  const own = deps.store.listBookings(userId);\n  const filtered = status.kind === "value" ? own.filter((booking) => booking.status === status.value) : own;\n',
  publish: { branch: "rename-own-list", commitMessage: "Rename the list variable in listBookings" },
  ticket: {
    title: "Rename the list variable in listBookings",
    what: "Call the caller's own bookings `own` in listBookings.",
    criteria: ["Listing behaves as before.", "All existing tests pass."],
  },
};

/** One scratch world: a copy of the target, private storage with the control template, and the paths. */
function world() {
  const target = tempDir("pipeline-target-");
  // node_modules too: the proofs and public tests import the target's dependencies. A plain copy, never a link.
  cpSync(realTarget, target, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  git("switch", "-q", "main");
  // A real run asks origin whether a branch name is taken: origin is a local bare clone, so nothing reaches the
  // network, and its main is the copy's.
  const origin = join(tempDir("pipeline-origin-"), "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", "--no-local", target, origin]);
  git("remote", "set-url", "origin", origin);
  git("fetch", "-q", "origin");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const branch of git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n")) {
    if (branch && branch !== "main") git("branch", "-q", "-D", branch);
  }
  const priv = tempDir("pipeline-private-");
  mkdirSync(join(priv, "templates", CONTROL_TEMPLATE.id), { recursive: true });
  writeFileSync(join(priv, "templates", CONTROL_TEMPLATE.id, "template.json"), JSON.stringify(CONTROL_TEMPLATE));
  return {
    target,
    priv,
    groundTruthPath: join(priv, "ground-truth.jsonl"),
    auditEventsPath: join(priv, "audit-events.jsonl"),
    reviewsDir: join(priv, "raw-artifacts", "reviews"),
  };
}

function inject(w: ReturnType<typeof world>, template: string, caseId: string): string {
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(root, "packages", "harness", "src", "inject.ts");
  try {
    execFileSync(process.execPath, [tsx, script, "--template", template, "--target", w.target, "--case", caseId], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FAULTFORGE_PRIVATE_DIR: w.priv },
      stdio: "pipe",
    });
    return "ok";
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return `exit ${e.status}: ${e.stderr}`;
  }
}

/** What the new-case skill and `review:wait` leave behind once a case's PR is open and reviewed. */
function reviewed(
  w: ReturnType<typeof world>,
  caseId: string,
  pr: number,
  review: { state: string; findings: object[]; comment: boolean },
) {
  const entry = readLedger(w.groundTruthPath).find((e) => e.caseId === caseId) as unknown as {
    injectionCommit: string;
  };
  const commit = entry.injectionCommit;
  appendFileSync(
    w.auditEventsPath,
    `${JSON.stringify({
      eventId: `${caseId}-pr`,
      type: "pr.opened",
      at: "2026-11-13T10:00:00.000Z",
      caseId,
      repo: REPO,
      pr,
      url: `https://github.com/${REPO}/pull/${pr}`,
      headCommit: commit,
      injectionCommit: commit,
      qodoConfiguration: "qodo-v9",
    })}\n`,
  );
  const dir = join(w.reviewsDir, `target-pr${pr}`);
  mkdirSync(dir, { recursive: true });
  const short = commit.slice(0, 7);
  writeFileSync(
    join(dir, `${short}.review.json`),
    JSON.stringify({
      repo: REPO,
      pr,
      headSha: commit,
      state: review.state,
      pushSeenAt: "2026-11-13T10:00:05Z",
      reviewStartedAt: "2026-11-13T10:00:10Z",
      reviewSeenCompleteAt: review.state === "complete" ? "2026-11-13T10:02:00.000Z" : null,
      recordedAt: "2026-11-13T10:02:01.000Z",
      findings: review.findings,
    }),
  );
  if (review.comment) {
    const comment = {
      user: { login: "qodo-code-review[bot]" },
      body: "<h3>Code Review by Qodo</h3>",
      html_url: `https://github.com/${REPO}/pull/${pr}#issuecomment-1`,
      updated_at: "2026-11-13T10:02:00Z",
    };
    writeFileSync(
      join(dir, `${short}.comments.latest.raw.json`),
      JSON.stringify({ pr: JSON.stringify([[comment]]), inline: "[[]]" }),
    );
  }
  return entry;
}

/**
 * The change the answer key says was planted, read from the scratch target itself: the recorded commit's own
 * diff, and that it sits on the base the key names. Bookkeeping alone can't stand in for the planted change
 * (Qodo on PR 241).
 */
function plantedDiff(w: ReturnType<typeof world>, caseId: string): string {
  const entry = readLedger(w.groundTruthPath).find((e) => e.caseId === caseId) as unknown as {
    injectionCommit: string;
    targetCommit: string;
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", w.target, ...args], { encoding: "utf8" });
  expect(git("rev-parse", `${entry.injectionCommit}^`).trim()).toBe(entry.targetCommit);
  return git("show", "--format=", entry.injectionCommit).replace(/\r\n/g, "\n");
}

/** The owner's answers: the verdict, then a reason of the case's own, then "real" for every finding. */
const owner = (answer: string, caseId: string) => async (question: string) =>
  question.startsWith("Verdict")
    ? answer
    : question.startsWith("Judge")
      ? "real"
      : `Checked ${caseId} against its saved review.`;

async function adjudicateAndBuild(w: ReturnType<typeof world>, caseId: string, answer: string) {
  const quiet = { log: () => {}, error: () => {} };
  const paths = { groundTruthPath: w.groundTruthPath, auditEventsPath: w.auditEventsPath, reviewsDir: w.reviewsDir };
  const env = { ...process.env, FAULTFORGE_PRIVATE_DIR: w.priv };
  expect(reviewCase(caseId, { ...paths, ...quiet, now: () => "2026-11-13T10:03:00.000Z" })).toBe(0);
  const errors: string[] = [];
  const verdictCode = await verdict(caseId, {
    ...paths,
    env,
    log: () => {},
    error: (line) => errors.push(line),
    isTTY: true,
    ask: owner(answer, caseId),
    ownerLogin: () => "owner",
    now: () => "2026-11-13T10:04:00.000Z",
  });
  expect(verdictCode, errors.join("\n")).toBe(0);
  const out: string[] = [];
  const buildCode = await buildCase(caseId, {
    ...paths,
    env,
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
    overlayPath: join(w.priv, "no-overlay.json"),
    examplesDir: join(w.priv, "examples"),
  });
  expect(buildCode, errors.join("\n")).toBe(0);
  const text = out.join("\n");
  const record = JSON.parse(text.slice(text.indexOf("{")));
  expect(validateCaseRecord(record)).toEqual([]);
  return record;
}

describe.skipIf(!hasRealTarget)("the case pipeline, inject to record (#229)", () => {
  it("takes a bug case to a detected record", { timeout: 300_000 }, async () => {
    const w = world();
    expect(inject(w, "idempotency-guard-bypass-v1", "FF-9101")).toBe("ok");
    expect(plantedDiff(w, "FF-9101")).toContain("+    const original = deps.store.getBooking(idempotencyKey);");
    const entry = readLedger(w.groundTruthPath).find((e) => e.caseId === "FF-9101") as unknown as {
      injectedFile: string;
      injectedLines: [number, number];
    };
    reviewed(w, "FF-9101", 901, {
      state: "complete",
      comment: true,
      findings: [
        {
          id: "f1",
          file: entry.injectedFile,
          lines: entry.injectedLines,
          severity: "action_required",
          category: "Correctness",
          title: "Replay looks the original booking up by the wrong key",
          description: "A repeated request misses the original and creates a duplicate booking.",
        },
        {
          id: "f2",
          file: "src/bookings/routes.ts",
          lines: [1, 2],
          severity: "remediation_recommended",
          category: "Testability",
          title: "The change has no test",
          description: "Nothing covers the new lookup.",
        },
      ],
    });
    const record = await adjudicateAndBuild(w, "FF-9101", "detected");
    expect(record).toMatchObject({
      kind: "sabotage",
      status: "complete",
      human: { disposition: "confirmed_detected" },
      detection: { caught: true, matchedFindingIds: ["qodo:f1"] },
    });
  });

  it("takes a clean control to a clean record", { timeout: 300_000 }, async () => {
    const w = world();
    expect(inject(w, CONTROL_TEMPLATE.id, "FF-9102")).toBe("ok");
    expect(plantedDiff(w, "FF-9102")).toContain("+  const own = deps.store.listBookings(userId);");
    reviewed(w, "FF-9102", 902, { state: "complete", comment: true, findings: [] });
    const record = await adjudicateAndBuild(w, "FF-9102", "clean");
    expect(record).toMatchObject({
      kind: "control",
      schemaVersion: 2,
      status: "complete",
      human: { disposition: "confirmed_clean" },
      change: { templateId: CONTROL_TEMPLATE.id, file: CONTROL_TEMPLATE.file },
    });
  });

  it("takes a review that didn't finish to an incomplete record", { timeout: 300_000 }, async () => {
    const w = world();
    expect(inject(w, CONTROL_TEMPLATE.id, "FF-9103")).toBe("ok");
    // Timed out, as review:wait saves it ("review incomplete"), with no comment feed: only "review incomplete" may
    // be recorded (Qodo on PR 241).
    reviewed(w, "FF-9103", 903, { state: "review incomplete", comment: false, findings: [] });
    const record = await adjudicateAndBuild(w, "FF-9103", "review incomplete");
    expect(record).toMatchObject({ status: "incomplete", human: { disposition: "review_incomplete" } });
  });
});
