/**
 * Is Qodo's "approved" label on a pull request backed by our own checks? The label is a claim about the head
 * commit. This reads the label's history from GitHub, the review `review:wait` saved for the head, our gate on
 * that review, the guarded paths (`approval` in `factory.json`, a copy of the portal's guards) and the CI jobs
 * the repo requires, and says whether they agree.
 *
 *   npm run approval:check -- faultforge 452             judge the head now
 *   npm run approval:check -- faultforge 452 --predict   before any review: does a guard hold it for a person?
 *
 * It reads only. The verdicts (`approval-rule.ts`): approved-verified, held-for-human, not-eligible, disagree.
 * The label counts only when Qodo's app added it (`approval.actor`) after Qodo began reviewing the head, so a
 * label a person added, or one left on from an older head, shows as disagree.
 *
 * Exit codes: 0 approved and verified, or a prediction was printed; 1 held for a person or not eligible, with
 * no label, as the rule says; 3 the label and our checks disagree; 2 it could not be decided (a bad argument,
 * a repo with no `approval` section, no saved review of the head, GitHub unreachable, or more changed files
 * than GitHub lists), or an unexpected error
 * stopped it, even while loading (`npm run approval:check` runs `approval-check-cli.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { gateOf, loadFactory, repoConfig } from "../shared/factory-config.ts";
import { ghAll, ghJson } from "../shared/github.ts";
import { type GateRecord, gateAccount } from "../shared/quality-gate.ts";
import { blockingLevels, guardedFiles, judge, type LabelEvent, labelProblem, predict } from "./approval-rule.ts";

export type { LabelEvent };

import { savedReviewPath, waitSaveDir } from "./saved-review.ts";

/** GitHub's REST list of a pull request's files stops at this many. */
export const MAX_LISTED_FILES = 3000;

/** A check as `gh pr view --json statusCheckRollup` gives it: a check run or a status context. */
export type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };

export interface PrView {
  headRefOid: string;
  labels: { name: string }[];
  statusCheckRollup?: Check[];
}

export interface ApprovalCheckDeps {
  view: (github: string, pr: number) => PrView;
  /** Every changed file's path. `gh pr view` stops at 100 files, so this pages through the REST list. */
  files: (github: string, pr: number) => string[];
  /** The pull request's timeline events (all kinds; only label events are used). */
  timeline: (github: string, pr: number) => LabelEvent[];
  read: (path: string) => string | undefined;
  out: (line: string) => void;
  error: (line: string) => void;
}

const realDeps: ApprovalCheckDeps = {
  view: (github, pr) =>
    ghJson<PrView>("pr", "view", String(pr), "--repo", github, "--json", "headRefOid,labels,statusCheckRollup"),
  // GitHub's REST list holds up to 3,000 files; a pull request that big is refused below rather than judged.
  files: (github, pr) => ghAll<{ filename: string }>(`repos/${github}/pulls/${pr}/files`).map((f) => f.filename),
  timeline: (github, pr) => ghAll<LabelEvent>(`repos/${github}/issues/${pr}/timeline`),
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Every required job succeeded on the head (a skipped or neutral required job did not run its steps), and no
 * other check failed (those may also be skipped or neutral).
 */
export function ciGreen(rollup: Check[], required: string[]): boolean {
  const conclusion = (c: Check) => (c.conclusion || c.state || "").toUpperCase();
  const ok = (c: Check) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion(c));
  const finished = (c: Check) =>
    c.status ? c.status.toUpperCase() === "COMPLETED" : conclusion(c) !== "" && conclusion(c) !== "PENDING";
  if (rollup.some((c) => finished(c) && !ok(c))) return false;
  return (
    required.length > 0 &&
    required.every((job) => rollup.some((c) => (c.name ?? c.context) === job && conclusion(c) === "SUCCESS"))
  );
}

export function run(argv: string[], deps: ApprovalCheckDeps = realDeps): number {
  const factory = loadFactory();
  const [repoKey, prText, flag] = argv;
  const pr = Number(prText);
  const usage = `usage: npm run approval:check -- <${Object.keys(factory.repos).join("|")}> <pull request number> [--predict]`;
  if (
    !repoKey ||
    !factory.repos[repoKey] ||
    !Number.isInteger(pr) ||
    pr <= 0 ||
    argv.length > 3 ||
    (flag !== undefined && flag !== "--predict")
  ) {
    deps.error(usage);
    return 2;
  }
  const repo = repoConfig(factory, repoKey);
  if (!repo.approval) {
    deps.error(`approval:check: factory.json has no approval section for ${repoKey}`);
    return 2;
  }
  const { label, actor, guards } = repo.approval;
  let view: PrView;
  let files: string[];
  try {
    view = deps.view(repo.github, pr);
    files = deps.files(repo.github, pr);
  } catch (e) {
    deps.error(`approval:check: couldn't read the pull request: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const head = view.headRefOid;
  if (!/^[0-9a-f]{40}$/i.test(head ?? "")) {
    deps.error("approval:check: GitHub gave no commit id for the pull request's head");
    return 2;
  }
  if (files.length >= MAX_LISTED_FILES) {
    deps.error(
      `approval:check: GitHub lists at most ${MAX_LISTED_FILES} changed files, so a guarded one may be missing`,
    );
    return 2;
  }
  deps.out(
    `${repoKey} pull request ${pr}, head ${head.slice(0, 7)}, ${files.length} changed file(s); guards: ${guards.join(", ") || "none"}`,
  );
  if (flag === "--predict") {
    const p = predict(files, guards);
    deps.out(
      p.verdict === "held-for-human"
        ? `prediction: held-for-human, no "${label}" label even with a clean review (guarded: ${p.guarded.join(", ")})`
        : `prediction: eligible-if-clean, the "${label}" label once Qodo's complete review of the head has no open finding above Low`,
    );
    return 0;
  }
  const path = savedReviewPath(waitSaveDir(repoKey, pr), head);
  const text = deps.read(path);
  if (text === undefined) {
    deps.error(
      `approval:check: no saved review of ${head.slice(0, 7)} at ${path}. Run: npm run review:wait -- ${repoKey} ${pr} --commit ${head}`,
    );
    return 2;
  }
  let record: GateRecord;
  try {
    record = JSON.parse(text) as GateRecord;
  } catch {
    deps.error(`approval:check: the saved review at ${path} can't be read as JSON`);
    return 2;
  }
  let events: LabelEvent[];
  try {
    events = deps
      .timeline(repo.github, pr)
      .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === label);
  } catch (e) {
    deps.error(`approval:check: couldn't read the label's history: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const gate = gateOf(factory);
  const open = Array.isArray(record.openFindings) ? (record.openFindings as { severity?: string }[]) : null;
  const reviewClean =
    record.headSha === head &&
    record.state === "complete" &&
    open !== null &&
    blockingLevels(
      open.map((f) => f?.severity),
      gate.flag,
    ).length === 0;
  const gateMet = gateAccount(record, gate, { head, requireComplete: true, rounds: "if-recorded" }).met;
  const green = ciGreen(view.statusCheckRollup ?? [], repo.ciJobs ?? []);
  const labelled = view.labels.some((l) => l.name === label);
  const problem = labelled
    ? labelProblem(events, actor, (record as { reviewStartedAt?: unknown }).reviewStartedAt)
    : null;
  for (const e of events) deps.out(`  ${e.created_at ?? "no time"}  ${e.event} by ${e.actor?.login ?? "unknown"}`);
  if (!events.length) deps.out(`  the "${label}" label was never added`);
  deps.out(
    `label now: ${labelled ? "yes" : "no"}; review of head: ${String(record.state)}, ${reviewClean ? "clean" : "not clean"}; gate:check: ${gateMet ? "met" : "not met"}; CI: ${green ? "green" : "not green"}`,
  );
  const result = judge({
    labelled,
    labelProblem: problem,
    guarded: guardedFiles(files, guards),
    reviewClean,
    gateMet,
    ciGreen: green,
  });
  deps.out(`verdict: ${result.verdict}`);
  for (const reason of result.reasons) deps.out(`  - ${reason}`);
  return result.verdict === "approved-verified" ? 0 : result.verdict === "disagree" ? 3 : 1;
}

/** The command: `approval-check-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): number {
  return run(argv);
}
