/**
 * What a push through the door (`target-post.ts`) would send to the reviewed repository, read from git (#340): the
 * branch's name, and for every commit the remote doesn't have yet its author, committer and message, the path of
 * every file it adds or changes, and that file's content at that commit. These are the texts the door checks; the
 * push then sends exactly the commit it read, to exactly the URL it checked, so nothing can change in between.
 *
 * "The remote doesn't have yet" is read after `git fetch --prune` from the remote: a stale or hand-made
 * remote-tracking ref can't hide a commit from the check. Every git call goes through `Git`, so tests use a fake.
 * Anything git can't read (a file in a submodule, a branch that isn't there) is a problem: the door then refuses.
 */
import { githubRepos } from "../../../.claude/hooks/guard-repos.ts";

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

/** Every URL `origin` fetches from and pushes to: all must name `repo`, or the push could go somewhere else. */
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
  const elsewhere = urls.filter((url) => githubRepos(url)[0] !== repo.toLowerCase());
  if (!pushed.length || elsewhere.length) return { problem: `${checkout}'s origin isn't only ${repo}` };
  return { url: pushed[0] };
}

/** The files a commit adds or changes (against each parent, so a merge's too), with no deletions. */
function changedFiles(checkout: string, commit: string, git: Git): string[] {
  const out = git(checkout, [
    "diff-tree",
    "-r",
    "-m",
    "--root",
    "--no-commit-id",
    "--no-renames",
    "--name-only",
    "-z",
    "--diff-filter=d",
    commit,
  ]);
  return [...new Set(out.split("\0").filter(Boolean))];
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
  let commit: string;
  let fresh: string[];
  try {
    git(checkout, ["fetch", "--quiet", "--prune", "origin"]);
    commit = git(checkout, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("not a commit");
    fresh = lines(git(checkout, ["rev-list", commit, "--not", "--remotes=origin"]));
  } catch {
    return { pieces, problems: [`can't read local branch ${branch} or what origin already has`] };
  }
  const problems: string[] = [];
  for (const sha of fresh) {
    const short = sha.slice(0, 12);
    try {
      pieces.push([`commit ${short}`, git(checkout, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", sha])]);
      for (const path of changedFiles(checkout, sha, git)) {
        pieces.push([`path in ${short}`, path]);
        pieces.push([`${path} at ${short}`, git(checkout, ["cat-file", "blob", `${sha}:${path}`])]);
      }
    } catch {
      problems.push(`can't read commit ${short} or one of its files`);
    }
  }
  return { pieces, problems, url: origin.url, commit };
}

/** The push itself: the commit that was read, to the URL that was checked, never forced, tags and submodules left. */
export function pushArgs(plan: Required<Pick<PushPlan, "url" | "commit">>, branch: string): string[] {
  return ["push", "--no-follow-tags", "--recurse-submodules=no", plan.url, `${plan.commit}:refs/heads/${branch}`];
}
