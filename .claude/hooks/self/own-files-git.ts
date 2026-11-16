/**
 * Git commands that would put another version of the guard's own files in place in a held checkout (re-grade 6,
 * Qodo on PR 337). Split from guard-self.ts, which says which files and checkouts are held. Refused there:
 *  - `checkout`, `restore`, `rm` and `mv` that name one of the files or a folder holding one, from any source;
 *  - `checkout`, `switch` and `reset` to a commit whose guard files differ from HEAD's,
 *    `merge` and `rebase` of one that changes them since the two met, and `cherry-pick` and `revert` of one that
 *    changes them. The protected `origin/main` is always a fine place to go: a guard change reaches it only by a PR;
 *  - `pull`, unless the branch follows `origin/main`;
 *  - what can't be read before it runs: `apply`, `am`, `stash pop`, `stash apply` and `stash branch` (their changes
 *    are in a patch or a stash), `update-ref`, a fetch into a named ref (it could move `origin/main`), and any change
 *    to where `origin` points (`git remote set-url`, `git config remote.*`);
 *  - any of those in a folder the guard can't follow (`git -C "$D" reset --hard x`).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Call } from "../target/history.ts";
import { configReads } from "./git-hooks.ts";

/** The guard's files as git pathspecs, relative to the checkout. */
const PATHSPECS = [
  ".claude/hooks",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "packages/harness/src/neutral.ts",
];

/** Git commands that put a commit's files in place. */
const MOVES = /^(checkout|switch|reset|merge|rebase|cherry-pick|revert|pull)$/;
/** Git commands whose changes the guard can't read before they run. */
const UNREAD = /^(apply|am|update-ref|filter-branch|filter-repo|replace)$/;

function git(dir: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 4000, windowsHide: true });
  return { status: r.status, out: (r.stdout ?? "").trim() };
}

/** The commit a word names in `dir`, or undefined. `-` is the branch before, as git reads it. */
function commitOf(dir: string, word: string): string | undefined {
  const r = git(dir, ["rev-parse", "--verify", "-q", `${word === "-" ? "@{-1}" : word}^{commit}`]);
  return r.status === 0 && r.out ? r.out : undefined;
}

/** True unless git says the guard's files are the same between the two (a diff that fails counts as different). */
function differs(dir: string, ...range: string[]): boolean {
  return git(dir, ["diff", "--quiet", ...range, "--", ...PATHSPECS]).status !== 0;
}

/** The options of these commands that take a value, whose value is no commit. */
const VALUED = /^(-b|-B|-c|-C|--orphan|-m|--message|-X|--strategy-option|--strategy|--conflict|--pathspec-from-file)$/;

/**
 * True when a git call in held checkout `root` would put another version of the guard's files in place there.
 * `touches` says whether a path is one of them, or a folder holding one.
 */
export function gitSelfProblem(call: Call, root: string, touches: (path: string) => boolean): boolean {
  const [sub = "", ...rest] = call.args;
  if (UNREAD.test(sub)) return true;
  if (sub === "stash") return /^(pop|apply|branch)$/.test(rest[0] ?? "");
  if (sub === "fetch") return rest.some((w) => !w.startsWith("-") && w.includes(":"));
  if (sub === "remote") return /^(add|set-url|rename|remove|rm|set-head|set-branches)$/.test(rest[0] ?? "");
  if (sub === "config") return !configReads(rest) && rest.some((w) => /^(remote|branch)\./i.test(w));
  const named = (sub === "checkout" || sub === "restore" || sub === "rm" || sub === "mv") && call.dir !== undefined;
  const dashes = rest.indexOf("--");
  const before = dashes < 0 ? rest : rest.slice(0, dashes);
  const paths = rest.filter((w, i) => !w.startsWith("-") && (dashes < 0 || i > dashes));
  if (named && paths.some((w) => !/[$`]/.test(w) && touches(resolve(call.dir ?? root, w)))) return true;
  if (!MOVES.test(sub)) return false;
  if (call.dir === undefined || rest.some((w) => /[$`]/.test(w))) return true;
  const dir = call.dir;
  const main = commitOf(dir, "refs/remotes/origin/main");
  if (sub === "pull") {
    const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).out;
    const plain = rest.filter((w) => !w.startsWith("-"));
    return !(upstream === "origin/main" && (plain.length === 0 || plain.join(" ") === "origin main"));
  }
  const words: string[] = [];
  for (let i = 0; i < before.length; i++) {
    const word = before[i] ?? "";
    if (VALUED.test(word)) i++;
    else if (!word.startsWith("-") || word === "-") words.push(word);
  }
  // A checkout of paths changes those paths alone, judged above by name.
  if (sub === "checkout" && (dashes >= 0 || words.length > 1)) return false;
  const targets = words.flatMap((w) => commitOf(dir, w) ?? []).filter((c) => c !== main);
  return targets.some((commit) => {
    if (sub === "merge" || sub === "rebase") return differs(dir, `HEAD...${commit}`);
    if (sub === "cherry-pick" || sub === "revert") return differs(dir, `${commit}^`, commit);
    return differs(dir, "HEAD", commit);
  });
}
