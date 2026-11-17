/**
 * The runner's own check of a pull request the agent says is ready: its state, head and checks on GitHub,
 * Qodo's review of its head (`review:wait`) and its tests (`revert:check`), both run from a trusted checkout
 * of `main`.
 */
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type FactoryConfig, gateOf, repoConfig } from "../shared/factory-config.ts";
import { ROOT as LAB_ROOT, prEvidenceDir } from "../shared/paths.ts";
import { type GateRecord, gateAccount } from "../shared/quality-gate.ts";
import { REVERT_CHECK_TIMEOUT_MS } from "./factory-exec.ts";
import { reviewerRuleGates } from "./factory-gates.ts";
import type { Workspace } from "./factory-tick.ts";
import { buildTrustedCheckout, removeTrustedCheckout } from "./trusted-checkout.ts";

export interface Verification {
  /** Problems that stop a PR from counting as delivered; empty when it checks out. */
  problems: string[];
  /** Where `revert:check`'s saved record was read back from, for the run log; null when the check
   * never ran (an earlier problem, such as an incomplete review, stopped verification first). */
  revertCheckRecord?: string | null;
  /** Why the PR waits for the owner whatever the agent reported, such as a change to the reviewer's rules. */
  ownerGates?: string[];
  /** The commit verified: the agent's last pushed commit. The check-defining files are compared at it. */
  head?: string;
}

/**
 * The commit the runner must see reviewed: the agent's own branch tip in its worktree. GitHub's PR view
 * can still show the previous head right after a push, so it is used only when the branch isn't
 * in the worktree. Null when neither is a commit id: the result goes on an npm command line.
 */
export function commitToVerify(localTip: string | null, viewHead: string): string | null {
  const commit = localTip ?? viewHead;
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : null;
}

/** One of a PR's checks as `gh pr view --json statusCheckRollup` gives it: a check run or a status context. */
export type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };

/** How often the runner reads a PR's checks again while some are still running, and for how long at most. */
export const CHECKS_POLL_MS = 30_000;
export const CHECKS_WAIT_MS = 15 * 60_000;

/**
 * True once a check has finished. A check run has finished when its `status` is `COMPLETED`; a status context
 * when its `state` is neither `PENDING` nor `EXPECTED`. A check that gives only a conclusion has finished.
 */
export function checkFinished(c: Check): boolean {
  if (c.status) return c.status.toUpperCase() === "COMPLETED";
  if (c.state) return !["PENDING", "EXPECTED"].includes(c.state.toUpperCase());
  return Boolean(c.conclusion);
}

const passed = (c: Check) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes((c.conclusion || c.state || "").toUpperCase());

/**
 * Reads a PR's view with `read` until its checks have all finished, a check has failed, or `CHECKS_WAIT_MS` has
 * passed since the first read, `CHECKS_POLL_MS` apart. Gives the last view, and whether checks were still
 * running when the time ran out. The agent can report a PR ready while its CI still runs (a review can take a
 * minute, the Windows jobs several), and a check that passes a few minutes later is not a failure.
 */
export function waitForChecks<V extends { statusCheckRollup?: Check[] }>(
  read: () => V,
  sleep: (ms: number) => void,
  now: () => number,
): { view: V; timedOut: boolean } {
  const started = now();
  for (;;) {
    const view = read();
    const rollup = view.statusCheckRollup ?? [];
    const failed = rollup.some((c) => checkFinished(c) && !passed(c));
    if (failed || rollup.every(checkFinished)) return { view, timedOut: false };
    if (now() - started >= CHECKS_WAIT_MS) return { view, timedOut: true };
    sleep(CHECKS_POLL_MS);
  }
}

/**
 * Saves the runner's record at `to`, replacing whatever is there, in a folder it creates when needed. It writes
 * the content and never copies the file: in GitHub Actions the agent runs as another user (`ffagent`), and when it
 * has run `revert:check` itself, the file at `to` already exists and is that user's. Node's `copyFileSync` then
 * also sets the file's permissions, which only the owner may do, so Linux refuses with EPERM. Writing the content
 * needs only write access to the file, which the runner has.
 *
 * The agent can write the folders below `root` (its own checkout), so it could put a link where the record goes,
 * and a write through it would land in any file the runner can write. So no folder from `root` down, and not the
 * file itself, may be a link, and the file is opened without following one where the system can (`O_NOFOLLOW`).
 */
export const MAX_RECORD_BYTES = 1024 * 1024;

export function saveRecord(from: string, to: string, root: string): void {
  const rel = relative(root, to);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${to} is not inside ${root}`);
  let path = root;
  for (const part of rel.split(sep)) {
    path = join(path, part);
    let link: boolean;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break; // the rest is made fresh below
      throw error;
    }
    if (link) throw new Error(`${path} is a link, so the record is not saved through it`);
  }
  // Read first: a record that can't be read must leave the one at `to` as it was, never emptied. Its test names
  // come from the pull request, so its size is capped before it is read whole.
  const size = statSync(from).size;
  if (size > MAX_RECORD_BYTES)
    throw new Error(`${from} is ${size} bytes, more than the ${MAX_RECORD_BYTES} a record may be`);
  const content = readFileSync(from);
  mkdirSync(dirname(to), { recursive: true });
  const fd = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Problems with the PR as GitHub shows it once the review of `pushed` is complete. */
export function prViewProblems(
  view: { state: string; headRefOid: string; statusCheckRollup?: Check[] },
  pushed: string,
  timedOut = false,
): string[] {
  const problems: string[] = [];
  if (view.state !== "OPEN") problems.push(`the pull request is ${String(view.state).toLowerCase()}, not open`);
  if (view.headRefOid !== pushed) {
    problems.push(
      `GitHub shows the head as ${view.headRefOid.slice(0, 7)}, not the agent's last commit ${pushed.slice(0, 7)}`,
    );
  }
  problems.push(...checkProblems(view.statusCheckRollup ?? [], timedOut));
  return problems;
}

/**
 * Problems with a PR's checks: none may be pending or failed, and at least one must have run. With `timedOut`
 * (the runner waited `CHECKS_WAIT_MS` and none had failed), the ones still running are named as not finished.
 */
export function checkProblems(rollup: Check[], timedOut = false): string[] {
  if (!rollup.length) return ["no checks ran on the pull request"];
  const bad = rollup.filter((c) => !passed(c));
  if (!bad.length) return [];
  const list = bad.map((c) => `${c.name ?? c.context} ${c.conclusion || c.state || c.status}`).join(", ");
  const failed = bad.some(checkFinished);
  return timedOut && !failed
    ? [`checks not finished after ${CHECKS_WAIT_MS / 60_000} minutes: ${list}`]
    : [`checks not green: ${list}`];
}

/**
 * A problem for `revert:check`'s exit code; empty only when the process exited 0 *and* its saved record
 * agrees the change was caught. A forged or stubbed script could exit 0 without writing a record.
 * Only the exit code and category reach a problem: the record's own text can hold agent-written test
 * names, which must never reach a ticket a reviewer can read. With no record, the last line of output
 * is used, bounded in size for the same reason.
 */
export function revertCheckProblems(status: number | null, record: { exit?: 0 | 1 | 2 } | null, output = ""): string[] {
  if (status === 0 && record?.exit === 0) return [];
  const category: Record<number, string> = {
    1: "every test still passes without the change, so it doesn't prove it",
    2: "it couldn't judge the change (no test or code file changed, a dependency change, or the tests failed with the change too)",
  };
  if (status === 0) {
    return [
      `revert:check exited 0 but its saved record ${record ? `says exit ${record.exit}` : "is missing"}, so its verdict can't be trusted`,
    ];
  }
  if (record && record.exit !== undefined && record.exit in category) {
    return [`revert:check: ${category[record.exit]} (full detail in its saved record)`];
  }
  const tail = output.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
  return [`revert:check gave no result (exit ${status}${tail ? `: ${tail}` : ""})`];
}

/** A saved JSON record, or null when it is missing or can't be parsed. A record a process died while
 * writing is no different from one never written: both read as no result, not as a crash. */
export function readJsonRecord(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The external calls `verifyPrWith` needs, so a test can hand it fakes for `gh` and `npm` while still
 * exercising the real `buildTrustedCheckout` (a real git clone of a real `main`) underneath it. */
export interface VerifyPrIo {
  ghJson: <T>(...args: string[]) => T;
  git: (cwd: string, ...args: string[]) => string;
  npm: (cwd: string, args: string[], timeoutMs?: number) => { status: number | null; output: string };
  /** Blocks for `ms` while checks run; a test passes its own, so nothing waits. */
  sleep?: (ms: number) => void;
  now?: () => number;
}

/** Blocks for `ms` without spinning: the verification is synchronous. */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Checks one pull request the agent says is ready: that Qodo's review of its head is complete and meets
 * the quality gate (`review:wait`, then `gateAccount`), and that its own new or changed tests actually catch
 * the change (`revert:check`). Both run from a freshly fetched checkout of `main`, never from `ws.lab`,
 * the agent's own worktree: otherwise the pull request being checked could edit the checks that judge it.
 *
 * `trustedRemoteUrl` turns the harness's GitHub address into the address to fetch from; a test can pass a
 * local bare repository's path instead, so the check runs with no network and no GitHub credentials.
 *
 * With `sandbox` (a CI run), `revert:check` runs the PR's tests as the agent's sandbox user, never as the
 * runner: they are the agent's code too.
 */
export function verifyPrWith(
  io: VerifyPrIo,
  factory: FactoryConfig,
  runsRoot: string,
  trustedRemoteUrl: (github: string) => string,
  ws: Workspace,
  repoKey: string,
  pr: number,
  sandbox = false,
): Verification {
  const repo = repoConfig(factory, repoKey);
  const { github } = repo;
  const first = io.ghJson<{ headRefOid: string; headRefName: string }>(
    "pr",
    "view",
    String(pr),
    "--repo",
    github,
    "--json",
    "headRefOid,headRefName",
  );
  // The agent's branch tip is what it pushed; GitHub's view of the head can lag a push.
  const dir = repo.path === "." ? ws.lab : resolve(ws.lab, repo.path);
  let localTip: string | null = null;
  try {
    localTip = io.git(dir, "rev-parse", "--verify", `refs/heads/${String(first.headRefName)}`);
  } catch {
    localTip = null;
  }
  const pushed = commitToVerify(localTip, String(first.headRefOid));
  if (!pushed) return { problems: ["no commit id for the pull request's head"] };

  const runId = basename(ws.root);
  const verifyRoot = join(runsRoot, `verify-${runId}-${repoKey}-pr${pr}`);
  rmSync(verifyRoot, { recursive: true, force: true });
  // The repo whose `factory.json` path is "." is the harness itself: its GitHub address, never any
  // checkout's own (mutable, untracked) `origin`, says where the trusted fetch must come from.
  const labRepo = Object.values(factory.repos).find((r) => r.path === ".");
  if (!labRepo)
    return {
      head: pushed,
      problems: ['factory.json names no repo at path ".", so there\'s nowhere trusted to fetch main from'],
    };
  let trustedLab: string;
  try {
    trustedLab = buildTrustedCheckout(
      verifyRoot,
      basename(LAB_ROOT),
      trustedRemoteUrl(labRepo.github),
      repo.path === "." ? undefined : { remoteUrl: trustedRemoteUrl(github), path: repo.path },
    );
  } catch (error) {
    return { head: pushed, problems: [error instanceof Error ? error.message : String(error)] };
  }

  const problems: string[] = [];
  let revertCheckRecord: string | null = null;
  let ownerGates: string[] = [];
  try {
    // --commit: it waits until GitHub shows the pushed commit, then for that commit's review.
    const review = io.npm(trustedLab, [
      "run",
      "-s",
      "review:wait",
      "--",
      repoKey,
      String(pr),
      "--commit",
      pushed,
      "--timeout",
      "5",
    ]);
    const short = pushed.slice(0, 7);
    // Keep whatever review:wait saved before the trusted checkout is removed, win or lose: a timed-out or
    // skipped review still saves the comments and raw API answers it saw, worth keeping as evidence.
    const trustedReviewDir = prEvidenceDir(join(trustedLab, factory.evidence), "reviews", repoKey, pr);
    const reviewRecordFile = join(trustedReviewDir, `${short}.review.json`);
    if (existsSync(trustedReviewDir)) {
      const permanentReviewDir = prEvidenceDir(join(ws.lab, factory.evidence), "reviews", repoKey, pr);
      try {
        mkdirSync(permanentReviewDir, { recursive: true });
        cpSync(trustedReviewDir, permanentReviewDir, { recursive: true });
      } catch (error) {
        problems.push(
          `couldn't save review:wait's evidence where the run log points: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const meaning: Record<number, string> = {
      1: "Qodo's review of the agent's last commit isn't complete, or the pull request's head never became it",
      2: "review:wait couldn't run",
      3: "Qodo skipped the review of the head commit",
    };
    if (review.status !== 0)
      return {
        head: pushed,
        problems: [meaning[review.status ?? 2] ?? `review:wait exited ${review.status}`, ...problems],
      };
    // Read again after the review: state, head and checks must all be of the pushed commit. Checks still
    // running are waited for, up to a limit.
    const { view, timedOut } = waitForChecks(
      () =>
        io.ghJson<Parameters<typeof prViewProblems>[0]>(
          "pr",
          "view",
          String(pr),
          "--repo",
          github,
          "--json",
          "state,headRefOid,statusCheckRollup",
        ),
      io.sleep ?? pauseSync,
      io.now ?? Date.now,
    );
    problems.push(...prViewProblems(view, pushed, timedOut));
    // Read from GitHub by the runner, never taken from the agent's report.
    try {
      ownerGates = reviewerRuleGates(io.ghJson("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/files`));
    } catch {
      ownerGates = reviewerRuleGates(null);
    }
    // A complete review can still have findings open: the quality gate says which of them block.
    if (!existsSync(reviewRecordFile)) problems.push("review:wait saved no review record for the head commit");
    else {
      // A damaged record is a problem to report, never a crash that loses the rest of this verdict.
      const record = readJsonRecord(reviewRecordFile) as GateRecord | null;
      if (!record) problems.push("review:wait's record for the head commit couldn't be read");
      // The file is named by the commit's first seven characters; the record's own `headSha` must agree in
      // full, so a record of another commit under that name is never judged as this one's. The rounds are
      // Qodo's own count, saved by review:wait in the trusted checkout, never the agent's.
      else
        problems.push(
          ...gateAccount(record, gateOf(factory), { head: pushed, requireComplete: true, rounds: "require" }).problems,
        );
    }

    // The PR's own new or changed tests must fail without its change. The runner checks this itself
    // rather than trusting the agent, from the same trusted checkout as review:wait.
    const revertRecordFile = join(
      prEvidenceDir(join(trustedLab, factory.evidence), "revert-checks", repoKey, pr),
      `${short}.revert-check.json`,
    );
    const permanentRecordFile = join(
      prEvidenceDir(join(ws.lab, factory.evidence), "revert-checks", repoKey, pr),
      `${short}.revert-check.json`,
    );
    const revert = io.npm(
      trustedLab,
      ["run", "-s", "revert:check", "--", repoKey, String(pr), ...(sandbox ? ["--sandbox"] : [])],
      REVERT_CHECK_TIMEOUT_MS,
    );
    // A damaged or missing record reads as no result, never throws: the rest of this verdict (the
    // review checks above) must still reach the caller.
    const revertRecord = readJsonRecord(revertRecordFile) as { exit?: 0 | 1 | 2 } | null;
    if (existsSync(revertRecordFile)) {
      try {
        saveRecord(revertRecordFile, permanentRecordFile, ws.lab);
        revertCheckRecord = permanentRecordFile;
      } catch (error) {
        problems.push(
          `couldn't save revert:check's record where the run log points: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    problems.push(...revertCheckProblems(revert.status, revertRecord, revert.output));
  } finally {
    const leftover = removeTrustedCheckout(verifyRoot);
    if (leftover) console.error(leftover);
  }
  return { problems, revertCheckRecord, ownerGates, head: pushed };
}
