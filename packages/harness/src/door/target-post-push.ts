/**
 * What a push through the door (`target-post.ts`) would send to the reviewed repository, read from git: the
 * branch's name, and for every commit the remote doesn't have yet its author, committer and message, the path of
 * every file it adds or changes, and that file's content at that commit. These are the texts the door checks; the
 * push then sends exactly the commit it read, to exactly the URL it checked, so nothing can change in between.
 *
 * "The remote doesn't have yet" is the remote's own answer (`git ls-remote`), so a stale or hand-made
 * remote-tracking ref can't hide a commit from the check. Every git call goes through `Git`, so tests use a fake.
 * Anything git can't read (a file in a submodule, a branch that isn't there) is a problem: the door then refuses.
 */

/** Runs git in `cwd` with `args` and returns stdout; throws when git fails. */
export type Git = (cwd: string, args: string[]) => string;

/** What one push would carry: the texts to check, by label, and where and what it pushes once they pass. */
export interface PushPlan {
  pieces: [string, string][];
  /** Problems found while reading: the push is refused when there is any. */
  problems: string[];
  /** The push URL checked to name the repo, and the commit that was read. */
  url?: string;
  commit?: string;
}

/** A branch name git and GitHub both take, and that can't read as an option or a range. */
export function branchNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z0-9][\w./-]*$/.test(name) || /\.\.|\/\/|\/$|\.lock$|\.$/.test(name)) {
    return `"${name}" isn't a plain branch name (letters, digits, and . _ / - between them)`;
  }
  return undefined;
}

/** Lines of git output, without blanks. */
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

import { githubRemote } from "../../../../.claude/hooks/shared/repos.ts";

/** A remote URL on github.com itself, as `owner/name`: the guard's own reader, shared with ci:wait. */
export { githubRemote };

/**
 * Every URL `origin` fetches from and pushes to: all must be `repo` on github.com, or the push could go somewhere
 * else. A URL rewrite in git's config (`url.<base>.insteadOf`, `pushInsteadOf`) could send it elsewhere too.
 */
function originUrls(checkout: string, repo: string, git: Git): { url?: string; problem?: string } {
  let fetched: string[];
  let pushed: string[];
  try {
    fetched = lines(git(checkout, ["remote", "get-url", "--all", "origin"]));
    pushed = lines(git(checkout, ["remote", "get-url", "--all", "--push", "origin"]));
  } catch {
    return { problem: `${checkout} has no origin remote git can read` };
  }
  const urls = [...fetched, ...pushed];
  const elsewhere = urls.filter((url) => githubRemote(url) !== repo.toLowerCase());
  if (!pushed.length || elsewhere.length) return { problem: `${checkout}'s origin isn't only ${repo} on github.com` };
  let rewrites = "";
  try {
    rewrites = git(checkout, ["config", "--get-regexp", String.raw`^url\..*\.(insteadof|pushinsteadof)$`]);
  } catch {
    // git exits 1 when no key matches: no rewrite.
  }
  if (rewrites.trim())
    return { problem: `${checkout}'s git config rewrites remote URLs, so the push could go elsewhere` };
  return { url: pushed[0] };
}

/**
 * Every path a commit touches (against each parent, so a merge's too), and whether it still has content there: a
 * deleted path's name shows in the diff too, so it is checked like any other.
 */
function touchedFiles(checkout: string, commit: string, git: Git): { path: string; deleted: boolean }[] {
  const out = git(checkout, [
    "diff-tree",
    "-r",
    "-m",
    "--root",
    "--no-commit-id",
    "--no-renames",
    "--name-status",
    "-z",
    commit,
  ]).split("\0");
  const found = new Map<string, boolean>();
  for (let i = 0; i + 1 < out.length; i += 2) {
    const path = out[i + 1] ?? "";
    if (path) found.set(path, (found.get(path) ?? true) && out[i] === "D");
  }
  return [...found].map(([path, deleted]) => ({ path, deleted }));
}

/**
 * The commits on the remote, by its own answer (`git ls-remote` on the checked URL), never by local
 * remote-tracking refs, which a narrowed refspec or a hand-made ref could leave pointing at a new commit.
 */
function remoteHeads(checkout: string, url: string, git: Git): string[] {
  return lines(git(checkout, ["ls-remote", url]))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
}

/**
 * Reads what pushing local branch `branch` of `checkout` to its origin, a checkout of `repo`, would send. Nothing
 * is pushed here.
 */
export function readPush(checkout: string, branch: string, repo: string, git: Git): PushPlan {
  const pieces: [string, string][] = [["branch name", branch]];
  const named = branchNameProblem(branch);
  if (named) return { pieces, problems: [named] };
  const origin = originUrls(checkout, repo, git);
  if (origin.problem) return { pieces, problems: [origin.problem] };
  const url = origin.url as string;
  let commit: string;
  let fresh: string[];
  try {
    commit = git(checkout, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("not a commit");
    // A remote commit this checkout doesn't have can't be in the branch's history: `--ignore-missing` skips it.
    const known = remoteHeads(checkout, url, git);
    fresh = lines(git(checkout, ["rev-list", "--ignore-missing", commit, "--not", ...known]));
  } catch {
    return { pieces, problems: [`can't read local branch ${branch} or what origin already has`] };
  }
  const problems: string[] = [];
  for (const sha of fresh) {
    const short = sha.slice(0, 12);
    try {
      pieces.push([`commit ${short}`, git(checkout, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", sha])]);
      for (const { path, deleted } of touchedFiles(checkout, sha, git)) {
        pieces.push([`path in ${short}`, path]);
        if (!deleted) pieces.push([`${path} at ${short}`, git(checkout, ["cat-file", "blob", `${sha}:${path}`])]);
      }
    } catch {
      problems.push(`can't read commit ${short} or one of its files`);
    }
  }
  return { pieces, problems, url, commit };
}

/** The push itself: the commit that was read, to the URL that was checked, never forced, tags and submodules left. */
export function pushArgs(plan: Required<Pick<PushPlan, "url" | "commit">>, branch: string): string[] {
  return ["push", "--no-follow-tags", "--recurse-submodules=no", plan.url, `${plan.commit}:refs/heads/${branch}`];
}
