/**
 * The git-level guard for a reviewed checkout (#191). The Claude Code guard reads commands, so a commit or
 * push started by a script is outside it; git runs its own hooks for every commit and push, whoever starts
 * them. `npm run guard:install` installs three hooks that call this file:
 *
 *   node git-guard.ts pre-commit <checkout>                  the staged files and their names
 *   node git-guard.ts commit-msg <checkout> <message file>   the commit message
 *   node git-guard.ts pre-push   <checkout> <remote> <url>   what this push sends (git's updates on stdin), and
 *                                                           every unpushed commit and local branch and tag name
 *
 * In the lab's own checkout it installs two more (re-grade 5), which only refuse a link to a reviewed repo's
 * issue or PR, because links go one way:
 *
 *   node git-guard.ts lab-commit-msg <checkout> <message file>   the commit message
 *   node git-guard.ts lab-pre-push   <checkout> <remote> <url>   the messages of the commits this push sends
 *
 * The checks are the Claude Code guard's own (guard-content.ts), read from git at the moment the content
 * would travel. A push must also keep the reviewed repo's history (re-grade 3): it may not delete a ref, and
 * each ref it updates must move forward from what the remote holds (`git merge-base --is-ancestor`). Git gives
 * the hook both commits for every ref, so this holds however the push was started: a script, a subprocess, a
 * folder the Claude Code guard couldn't resolve, or a URL it didn't recognise.
 *
 * Exit codes: 0 nothing in it names the lab or the bug (in the lab: links a reviewed repo's issue or PR), and no
 * push rewrites or deletes history; 1 refused: something does, or the content or history could not be read, or
 * the call was malformed. A hook that can't check refuses: git then stops the commit or push.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  DEFAULT_BUDGET_MS,
  type Pending,
  type PushUpdate,
  pendingIndex,
  pendingPush,
  pendingPushUpdates,
  reasonsIn,
  withDeadline,
  withPrivateNames,
} from "./guard-content.ts";
import { privateIdMatcher, privateTemplateIds } from "./guard-private.ts";
import { linkPattern, reviewedRepos } from "./guard-repos.ts";
import { firstLine, isEntry } from "./hook-io.ts";

/** What one hook call found: the reasons and where, or nothing when the content reads as ordinary. */
export function check(stage: string, checkout: string, arg?: string, stdin = ""): Pending | undefined {
  // One deadline for every scan this hook runs (audit N-4).
  // Private template ids may not travel either (AUD-H1); none are known where there is no private folder.
  const names = privateIdMatcher(privateTemplateIds(process.env));
  return withDeadline(DEFAULT_BUDGET_MS, () => withPrivateNames(names, () => checkNow(stage, checkout, arg, stdin)));
}

/** The one reason the lab's hooks give: links go one way. */
export const LINK_REASON = "links to a reviewed repo's issue or PR";

/** True when the text links a reviewed repo's issue or PR (`owner/name#N`, `name#N`, or an issue or PR URL). */
function linksReviewed(text: string): boolean {
  return linkPattern(reviewedRepos(process.env.FAULTFORGE_CONFIG))?.test(text) ?? false;
}

/**
 * The messages of every commit a lab push sends (re-grade 5): for each ref update, what the remote doesn't
 * have. When the remote's old commit isn't here, every commit no ref of the remote holds is read instead.
 */
function pushedMessages(checkout: string, remote: string, updates: PushUpdate[]): string {
  const log = (range: string[]) =>
    spawnSync("git", ["-C", checkout, "log", "--format=%B", ...range], {
      encoding: "utf8",
      timeout: DEFAULT_BUDGET_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  const texts: string[] = [];
  for (const u of updates) {
    if (ZERO.test(u.localSha)) continue;
    const all = [u.localSha, "--not", `--remotes=${remote}`];
    let r = log(ZERO.test(u.remoteSha) ? all : [u.localSha, `^${u.remoteSha}`]);
    if (r.status !== 0 && !ZERO.test(u.remoteSha)) r = log(all);
    if (r.status !== 0) throw new Error(`git log failed: ${(r.stderr || r.error?.message || "").split("\n")[0]}`);
    texts.push(r.stdout);
  }
  return texts.join("\n");
}

/**
 * The lab's own hooks (re-grade 5): a commit message, or the messages of the commits a push sends, may not link
 * a reviewed repo's issue or PR, where GitHub would show the lab on its timeline. The lab's own words are free.
 */
function checkLab(stage: string, checkout: string, arg?: string, stdin = ""): Pending | undefined {
  if (!arg) throw new Error(`${stage} needs the argument git passes`);
  const [text, where] =
    stage === "lab-commit-msg"
      ? [readFileSync(arg, "utf8"), "the commit message"]
      : [pushedMessages(checkout, arg, parseUpdates(stdin)), "a commit this push sends"];
  return linksReviewed(text) ? { reasons: [LINK_REASON], where } : undefined;
}

function checkNow(stage: string, checkout: string, arg?: string, stdin = ""): Pending | undefined {
  if (stage === "lab-commit-msg" || stage === "lab-pre-push") return checkLab(stage, checkout, arg, stdin);
  let pending: Pending;
  if (stage === "pre-commit") pending = pendingIndex(checkout);
  else if (stage === "pre-push") {
    // Git names the remote and passes each proposed update on stdin: what this push really sends, to the
    // ref names it really creates, is checked, as well as everything not yet on any remote (Qodo on PR 213).
    if (!arg) throw new Error("pre-push needs the remote name git passes");
    const updates = parseUpdates(stdin);
    const rewrite = historyProblem(checkout, updates);
    if (rewrite) return { reasons: [rewrite], where: HISTORY };
    const pushed = pendingPushUpdates(checkout, arg, updates);
    pending = pushed.reasons.length ? pushed : pendingPush(checkout);
  } else if (stage === "commit-msg") {
    if (!arg) throw new Error("commit-msg needs the message file git passes");
    // The whole file: with `-m`, git keeps lines that start with `#` (Qodo on PR 213).
    pending = { reasons: reasonsIn(readFileSync(arg, "utf8")), where: "the commit message" };
  } else throw new Error(`unknown stage ${stage}`);
  return pending.reasons.length ? pending : undefined;
}

/** The `where` of a refusal for a push that would rewrite or delete history. */
export const HISTORY = "this push";

const ZERO = /^0+$/;

/**
 * Why a push would rewrite or delete the reviewed repo's history, or undefined when every update only moves a
 * ref forward or creates one. A remote commit that isn't here can't be checked, so it refuses: fetch first.
 * The ref is never named: its name could be a private template's.
 */
export function historyProblem(checkout: string, updates: PushUpdate[]): string | undefined {
  for (const u of updates) {
    if (ZERO.test(u.localSha)) return "deletes a ref";
    if (ZERO.test(u.remoteSha)) continue;
    const r = spawnSync("git", ["-C", checkout, "merge-base", "--is-ancestor", u.remoteSha, u.localSha], {
      encoding: "utf8",
      timeout: DEFAULT_BUDGET_MS,
    });
    if (r.status === 1) return "rewrites a ref: what the remote holds is not in what it sends";
    if (r.status !== 0) return "may rewrite a ref: the remote's commit isn't here to compare, so fetch first";
  }
  return undefined;
}

/** The ref updates git writes to a pre-push hook's stdin: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parseUpdates(stdin: string): PushUpdate[] {
  return stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([, localSha = "", remoteRef = "", remoteSha = ""]) => ({ localSha, remoteRef, remoteSha }));
}

function main(): number {
  const [stage = "", checkout = "", arg] = process.argv.slice(2);
  try {
    if (!checkout) throw new Error("usage: git-guard.ts <[lab-]pre-commit|commit-msg|pre-push> <checkout> [arg]");
    const push = stage === "pre-push" || stage === "lab-pre-push";
    const found = check(stage, checkout, arg, push ? readFileSync(0, "utf8") : "");
    if (!found) return 0;
    if (found.reasons.includes(LINK_REASON)) {
      console.error(
        `review guard: refused. ${found.where} ${LINK_REASON}, which would show on its timeline. Name the work as plain text instead, like "target 3".`,
      );
      return 1;
    }
    if (found.where === HISTORY) {
      console.error(
        `review guard: refused. This push ${found.reasons.join(", ")}. A reviewed repo's history is evidence for recorded cases: never force, rewrite or delete.`,
      );
      return 1;
    }
    // A branch named after a private template would be printed in `where`: never print it (Qodo on PR 265).
    const where = found.reasons.includes("names a private template") ? "what this would send" : found.where;
    console.error(
      `review guard: refused. ${where} would give the change away (${found.reasons.join(", ")}). Remove it and try again.`,
    );
    return 1;
  } catch (error) {
    console.error(`review guard: refused, because it could not check (${firstLine(error)}).`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exit(main());
