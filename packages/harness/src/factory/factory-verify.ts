/**
 * The runner's own check of a pull request the agent says is ready: its state, head and checks on GitHub,
 * Qodo's review of its head (`review:wait`) and its tests (`revert:check`), both run from a trusted checkout
 * of `main`.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type FactoryConfig, repoConfig } from "../shared/factory-config.ts";
import { ROOT as LAB_ROOT, prEvidenceDir } from "../shared/paths.ts";
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

/** Problems with the PR as GitHub shows it once the review of `pushed` is complete. */
export function prViewProblems(
  view: { state: string; headRefOid: string; statusCheckRollup?: Parameters<typeof checkProblems>[0] },
  pushed: string,
): string[] {
  const problems: string[] = [];
  if (view.state !== "OPEN") problems.push(`the pull request is ${String(view.state).toLowerCase()}, not open`);
  if (view.headRefOid !== pushed) {
    problems.push(
      `GitHub shows the head as ${view.headRefOid.slice(0, 7)}, not the agent's last commit ${pushed.slice(0, 7)}`,
    );
  }
  problems.push(...checkProblems(view.statusCheckRollup ?? []));
  return problems;
}

/** Problems with a PR's checks: none may be pending or failed, and at least one must have run. */
export function checkProblems(
  rollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[],
): string[] {
  if (!rollup.length) return ["no checks ran on the pull request"];
  const bad = rollup.filter((c) => {
    const state = (c.conclusion || c.state || c.status || "").toUpperCase();
    return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state);
  });
  return bad.length
    ? [
        `checks not green: ${bad.map((c) => `${c.name ?? c.context} ${c.conclusion || c.state || c.status}`).join(", ")}`,
      ]
    : [];
}

/** Titles of the action-required findings still open in a `review:wait` record. */
export function openActionRequired(record: {
  openFindings?: { severity?: string | null; title?: string | null }[];
}): string[] {
  return (record.openFindings ?? [])
    .filter((f) => f.severity === "action_required")
    .map((f) => f.title ?? "(untitled)");
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
}

/**
 * Checks one pull request the agent says is ready: that Qodo's review of its head is complete with no
 * action-required finding open (`review:wait`), and that its own new or changed tests actually catch
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
    // Read again after the review: state, head and checks must all be of the pushed commit.
    const view = io.ghJson<Parameters<typeof prViewProblems>[0]>(
      "pr",
      "view",
      String(pr),
      "--repo",
      github,
      "--json",
      "state,headRefOid,statusCheckRollup",
    );
    problems.push(...prViewProblems(view, pushed));
    // Read from GitHub by the runner, never taken from the agent's report.
    try {
      ownerGates = reviewerRuleGates(io.ghJson("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/files`));
    } catch {
      ownerGates = reviewerRuleGates(null);
    }
    // A complete review can still have findings open: only none action-required counts as ready.
    if (!existsSync(reviewRecordFile)) problems.push("review:wait saved no review record for the head commit");
    else {
      // A damaged record is a problem to report, never a crash that loses the rest of this verdict.
      const record = readJsonRecord(reviewRecordFile) as Parameters<typeof openActionRequired>[0] | null;
      if (!record) problems.push("review:wait's record for the head commit couldn't be read");
      else {
        const open = openActionRequired(record);
        if (open.length) problems.push(`${open.length} action-required finding(s) still open: ${open.join("; ")}`);
      }
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
        mkdirSync(dirname(permanentRecordFile), { recursive: true });
        copyFileSync(revertRecordFile, permanentRecordFile);
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
