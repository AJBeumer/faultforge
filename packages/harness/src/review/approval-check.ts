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
 * A label that stays on after a new push is judged against the new head, so a stale label shows as disagree.
 *
 * Exit codes: 0 approved and verified, or a prediction was printed; 1 held for a person or not eligible, with
 * no label, as the rule says; 3 the label and our checks disagree; 2 it could not be decided (a bad argument,
 * a repo with no `approval` section, no saved review of the head, GitHub unreachable), or an unexpected error
 * stopped it, even while loading (`npm run approval:check` runs `approval-check-cli.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { gateOf, loadFactory, repoConfig } from "../shared/factory-config.ts";
import { ghAll, ghJson } from "../shared/github.ts";
import { type GateRecord, gateAccount } from "../shared/quality-gate.ts";
import { blockingLevels, guardedFiles, judge, predict } from "./approval-rule.ts";
import { savedReviewPath, waitSaveDir } from "./saved-review.ts";

/** A check as `gh pr view --json statusCheckRollup` gives it: a check run or a status context. */
export type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };

export interface PrView {
  headRefOid: string;
  labels: { name: string }[];
  files: { path: string }[];
  statusCheckRollup?: Check[];
}

export interface LabelEvent {
  event?: string;
  label?: { name?: string };
  actor?: { login?: string } | null;
  created_at?: string;
}

export interface ApprovalCheckDeps {
  view: (github: string, pr: number) => PrView;
  /** The pull request's timeline events (all kinds; only label events are used). */
  timeline: (github: string, pr: number) => LabelEvent[];
  read: (path: string) => string | undefined;
  out: (line: string) => void;
  error: (line: string) => void;
}

const realDeps: ApprovalCheckDeps = {
  view: (github, pr) =>
    ghJson<PrView>("pr", "view", String(pr), "--repo", github, "--json", "headRefOid,labels,files,statusCheckRollup"),
  timeline: (github, pr) => ghAll<LabelEvent>(`repos/${github}/issues/${pr}/timeline`),
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Every required job ran on the head and passed (success, neutral or skipped), and no check failed. */
export function ciGreen(rollup: Check[], required: string[]): boolean {
  const conclusion = (c: Check) => (c.conclusion || c.state || "").toUpperCase();
  const ok = (c: Check) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion(c));
  const finished = (c: Check) =>
    c.status ? c.status.toUpperCase() === "COMPLETED" : conclusion(c) !== "" && conclusion(c) !== "PENDING";
  if (rollup.some((c) => finished(c) && !ok(c))) return false;
  return required.length > 0 && required.every((job) => rollup.some((c) => (c.name ?? c.context) === job && ok(c)));
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
  const { label, guards } = repo.approval;
  let view: PrView;
  try {
    view = deps.view(repo.github, pr);
  } catch (e) {
    deps.error(`approval:check: couldn't read the pull request: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const head = view.headRefOid;
  if (!/^[0-9a-f]{40}$/i.test(head ?? "")) {
    deps.error("approval:check: GitHub gave no commit id for the pull request's head");
    return 2;
  }
  // shortcut: `gh pr view` lists at most 100 files; a bigger PR needs the REST files endpoint.
  const files = view.files.map((f) => f.path);
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
  for (const e of events) deps.out(`  ${e.created_at ?? "no time"}  ${e.event} by ${e.actor?.login ?? "unknown"}`);
  if (!events.length) deps.out(`  the "${label}" label was never added`);
  deps.out(
    `label now: ${labelled ? "yes" : "no"}; review of head: ${String(record.state)}, ${reviewClean ? "clean" : "not clean"}; gate:check: ${gateMet ? "met" : "not met"}; CI: ${green ? "green" : "not green"}`,
  );
  const result = judge({ labelled, guarded: guardedFiles(files, guards), reviewClean, gateMet, ciGreen: green });
  deps.out(`verdict: ${result.verdict}`);
  for (const reason of result.reasons) deps.out(`  - ${reason}`);
  return result.verdict === "approved-verified" ? 0 : result.verdict === "disagree" ? 3 : 1;
}

/** The command: `approval-check-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): number {
  return run(argv);
}
