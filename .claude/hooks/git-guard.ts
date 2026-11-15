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
 * In the lab's own checkout it installs three more (re-grade 5), which refuse a link to a reviewed repo's issue or
 * PR, because links go one way, and a private template's id (re-grade 6). The lab's pre-push also refuses a remote
 * that is a reviewed repo, by URL or local path: the lab's history never goes there (re-grade 6). Its pre-commit and
 * commit-msg refuse a copy of the answer key, the audit log or a private template, compared by hash
 * (guard-answer-key.ts; re-grade 6, Q21), and the pre-commit a private template's id in a staged file.
 *
 *   node git-guard.ts lab-pre-commit <checkout>                  the staged files and their names
 *   node git-guard.ts lab-commit-msg <checkout> <message file>   the commit message
 *   node git-guard.ts lab-pre-push   <checkout> <remote> <url>   where the push goes, and the messages it sends
 *
 * In the private checkout it installs one (re-grade 6), which refuses a push to anything but the `origin` URL
 * `guard:install` recorded (`review-guard.origin`), so the private history goes nowhere else:
 *
 *   node git-guard.ts private-pre-push <checkout> <remote> <url>
 *
 * The checks are the Claude Code guard's own (guard-content.ts), read from git at the moment the content
 * would travel. A push must also keep the reviewed repo's history (re-grade 3): it may not delete a ref, and
 * each ref it updates must move forward from what the remote holds (`git merge-base --is-ancestor`). Git gives
 * the hook both commits for every ref, so this holds however the push was started: a script, a subprocess, a
 * folder the Claude Code guard couldn't resolve, or a URL it didn't recognise.
 *
 * Exit codes: 0 nothing in it names the lab or the bug (in the lab: links a reviewed repo's issue or PR, names a
 * private template, copies private storage, or goes to a reviewed repo; in the private checkout: goes anywhere but its origin), and no
 * push rewrites or deletes history; 1 refused: something does, or the content or history could not be read, or
 * the call was malformed. A hook that can't check refuses: git then stops the commit or push.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { labIndex, lazyCopyTest } from "./guard-answer-key.ts";
import {
  copyReasons,
  DEFAULT_BUDGET_MS,
  type Pending,
  type PushUpdate,
  pendingIndex,
  pendingPush,
  pendingPushUpdates,
  pushedTexts,
  reasonsIn,
  withDeadline,
  withPrivateCopies,
  withPrivateNames,
} from "./guard-content.ts";
import { privateIdMatcher, privateTemplateIds } from "./guard-private.ts";
import { githubRepos, linkPattern, locate, reviewedRepos } from "./guard-repos.ts";
import { firstLine, isEntry } from "./hook-io.ts";

/** What one hook call found: the reasons and where, or nothing when the content reads as ordinary. */
export function check(stage: string, checkout: string, arg?: string, stdin = "", url?: string): Pending | undefined {
  // One deadline for every scan this hook runs (audit N-4).
  // Private template ids may not travel either (AUD-H1); none are known where there is no private folder.
  const names = privateIdMatcher(privateTemplateIds(process.env));
  // Nor a copy of the answer key, the audit log or a private template (re-grade 6, Q21).
  return withDeadline(DEFAULT_BUDGET_MS, () =>
    withPrivateNames(names, () =>
      withPrivateCopies(lazyCopyTest(process.env), () => checkNow(stage, checkout, arg, stdin, url ?? arg, names)),
    ),
  );
}

/** The reason the lab's pre-push gives for a remote that is a reviewed repo (re-grade 6). */
export const REVIEWED_REMOTE = "goes to a reviewed repo";
/** The reason the private checkout's pre-push gives for any remote but its recorded origin (re-grade 6). */
export const OTHER_REMOTE = "goes somewhere other than the private repo's origin";
/** The reason a lab message gives when it names a private template. */
export const PRIVATE_ID = "names a private template";

/** True when a push URL (or local path) is a reviewed repo: by GitHub URL in any spelling, or by its checkout. */
function reviewedRemote(checkout: string, url: string): boolean {
  const reviewed = reviewedRepos(process.env.FAULTFORGE_CONFIG);
  const github = githubRepos(url);
  if (github.length) return reviewed.some((r) => github.includes(r.github.toLowerCase()));
  if (/^[\w+.-]+:\/\//.test(url) && !/^file:/i.test(url)) return false;
  return locate(resolve(checkout, url.replace(/^file:\/\//i, "")), reviewed) !== undefined;
}

/**
 * Why a push from the private checkout goes somewhere it may not, or undefined (re-grade 6): the URL must be the
 * origin `guard:install` recorded, as written or as the same GitHub repo. With nothing recorded, nothing may go.
 */
function privatePush(checkout: string, url: string): Pending | undefined {
  const r = spawnSync("git", ["-C", checkout, "config", "--get", "review-guard.origin"], {
    encoding: "utf8",
    timeout: DEFAULT_BUDGET_MS,
  });
  const origin = r.status === 0 ? r.stdout.trim() : "";
  const [mine, theirs] = [githubRepos(origin), githubRepos(url)];
  const same = origin === url || (mine.length > 0 && theirs.length > 0 && theirs.every((repo) => mine.includes(repo)));
  return origin && same ? undefined : { reasons: [OTHER_REMOTE], where: HISTORY };
}

/** The one reason the lab's hooks give: links go one way. */
export const LINK_REASON = "links to a reviewed repo's issue or PR";

/** True when the text links a reviewed repo's issue or PR (`owner/name#N`, `name#N`, or an issue or PR URL). */
function linksReviewed(text: string): boolean {
  return linkPattern(reviewedRepos(process.env.FAULTFORGE_CONFIG))?.test(text) ?? false;
}

/**
 * The messages of every commit a lab push sends (re-grade 5): for each ref update, what the remote doesn't have.
 * What the remote has is asked of the remote itself (`git ls-remote`), never read from local remote-tracking
 * refs, which anyone can move (Qodo on PR 329), and which a push to a URL has none of. Git's own old commit for
 * the ref counts too. A remote commit that isn't here is skipped (`--ignore-missing`): more is read, never less.
 */
function pushedMessages(checkout: string, remote: string, updates: PushUpdate[]): string {
  // Both git calls share one budget, so the hook never waits past it (Qodo on PR 329).
  const end = Date.now() + DEFAULT_BUDGET_MS;
  const git = (args: string[], input?: string) => {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`the guard's ${DEFAULT_BUDGET_MS} ms ran out before git ${args[0]}`);
    const r = spawnSync("git", ["-C", checkout, ...args], {
      input,
      encoding: "utf8",
      timeout: left,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0)
      throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || "").split("\n")[0]}`);
    return r.stdout;
  };
  const sending = updates.filter((u) => !ZERO.test(u.localSha));
  if (!sending.length) return "";
  const held = git(["ls-remote", "--heads", "--tags", remote])
    .split("\n")
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  // One log for every ref: each update's old commit is on the remote, so it is excluded for all of them.
  const old = sending.map((u) => u.remoteSha).filter((sha) => !ZERO.test(sha));
  const revs = [...sending.map((u) => u.localSha), "--not", ...held, ...old, ""].join("\n");
  return git(["log", "--format=%B", "--ignore-missing", "--stdin"], revs);
}

/**
 * The lab's own hooks (re-grade 5): a commit message, or the messages of the commits a push sends, may not link
 * a reviewed repo's issue or PR, where GitHub would show the lab on its timeline. The lab's own words are free.
 */
function checkLab(
  stage: string,
  checkout: string,
  arg: string | undefined,
  stdin: string,
  url: string | undefined,
  names: ((text: string) => boolean) | undefined,
): Pending | undefined {
  // The staged files may not copy private storage or name a private template (re-grade 6, Q21).
  if (stage === "lab-pre-commit") {
    const staged = labIndex(checkout, names);
    return staged.reasons.length ? staged : undefined;
  }
  if (!arg) throw new Error(`${stage} needs the argument git passes`);
  // The lab's history never goes to a reviewed repo, by URL or by a remote that points there (re-grade 6).
  if (stage === "lab-pre-push" && reviewedRemote(checkout, url ?? arg))
    return { reasons: [REVIEWED_REMOTE], where: HISTORY };
  const [text, where] =
    stage === "lab-commit-msg"
      ? [readFileSync(arg, "utf8"), "the commit message"]
      : [pushedMessages(checkout, arg, parseUpdates(stdin)), "a commit this push sends"];
  if (linksReviewed(text)) return { reasons: [LINK_REASON], where };
  // Nor a copy of private storage, in the message or in a file a pushed commit holds: one made before the lab's
  // pre-commit hook was installed, or past it (Qodo on PR 337).
  const files = stage === "lab-pre-push" ? pushedTexts(checkout, arg, parseUpdates(stdin)) : [];
  const copies = copyReasons([text, ...files]);
  if (copies.length) return { reasons: copies, where };
  // A lab commit is public: it may not name a private template either (re-grade 6).
  return names?.(text) ? { reasons: [PRIVATE_ID], where } : undefined;
}

function checkNow(
  stage: string,
  checkout: string,
  arg: string | undefined,
  stdin: string,
  url: string | undefined,
  names: ((text: string) => boolean) | undefined,
): Pending | undefined {
  if (/^lab-(pre-commit|commit-msg|pre-push)$/.test(stage)) return checkLab(stage, checkout, arg, stdin, url, names);
  if (stage === "private-pre-push") {
    if (!url) throw new Error("private-pre-push needs the URL git passes");
    return privatePush(checkout, url);
  }
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
    const message = readFileSync(arg, "utf8");
    // Nor a line of the answer key or the audit log (Qodo on PR 337).
    pending = { reasons: [...reasonsIn(message), ...copyReasons([message])], where: "the commit message" };
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
  const [stage = "", checkout = "", arg, url] = process.argv.slice(2);
  try {
    if (!checkout) throw new Error("usage: git-guard.ts <[lab-]pre-commit|commit-msg|pre-push> <checkout> [arg]");
    const push = /pre-push$/.test(stage);
    const found = check(stage, checkout, arg, push ? readFileSync(0, "utf8") : "", url);
    if (!found) return 0;
    if (found.reasons.includes(REVIEWED_REMOTE) || found.reasons.includes(OTHER_REMOTE)) {
      const why = found.reasons.includes(OTHER_REMOTE)
        ? "the private history goes only to its own origin"
        : "a reviewed repo gets history only from its own checkout";
      console.error(`review guard: refused. This push ${found.reasons.join(", ")}: ${why}.`);
      return 1;
    }
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
    const where = found.reasons.includes(PRIVATE_ID) ? "what this would send" : found.where;
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
