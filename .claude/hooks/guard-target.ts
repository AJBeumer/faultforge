/**
 * Claude Code PreToolUse hook. Keeps the reviewed repositories free of hints for the reviewer.
 *
 * The reviewed repos are the ones with `"guard": "reviewed"` in `factory.json`. For each, it blocks:
 *  - force pushes
 *  - commits, pushes, PRs, comments and API writes whose text, or whose posted files, name the lab or the bug
 *  - file edits by the Edit and Write tools whose new content does the same
 *  - any `git commit` or `git push`, wherever it runs, while a reviewed checkout holds pending content
 *    (staged, unstaged or untracked for a commit; unpushed commits for a push) that names the lab or the bug.
 *    Shell text can't show what a redirect, a copy or a script wrote, so the content is read from git at
 *    the moment it would travel. That is the guarantee; the text checks are the early warning.
 * A command is "in" a reviewed repo when it names the repo as a destination, moves into its checkout
 * (cd, pushd, Set-Location, git -C, git --work-tree), or runs from inside it.
 * And everywhere else it blocks issues, PRs and commit messages that link to a reviewed repo.
 *
 * Reads the hook payload on stdin. Prints a deny decision as JSON, or nothing to allow.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";

interface Reviewed {
  /** owner/name on GitHub */
  github: string;
  /** The repo name on GitHub. */
  name: string;
  /** The local checkout's folder name, from its configured path. */
  folder: string;
  /** The local checkout, resolved from this repo's root, where pending content is read from git. */
  checkout: string;
}

const LAB_ROOT = join(import.meta.dirname, "../..");

/** Always protected, whatever the config says: the config can add reviewed repos, never remove this one. */
const TARGET: Reviewed = {
  github: "AJBeumer/faultforge-target",
  name: "faultforge-target",
  folder: "faultforge-target",
  checkout: resolve(LAB_ROOT, "../faultforge-target"),
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REVIEWED = reviewedRepos();

// Filled in by main(); the check functions read them. `args` is the tool's input as parsed from JSON.
let tool = "";
let args: ReturnType<typeof JSON.parse> = {};
let cwd = process.cwd();

main();

/**
 * Fails closed. Claude Code treats a hook that crashes (exit 1, a stack trace) as a non-blocking error
 * and runs the tool anyway, so an exception here (unreadable input, a body file that is a folder) would
 * be a bypass. Any error becomes a blocking error instead: exit 2 with a one-line reason on stderr,
 * which Claude Code shows to the agent and acts on by refusing the tool call.
 */
function main() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    tool = String(input.tool_name ?? "");
    args = input.tool_input ?? {};
    cwd = String(input.cwd ?? process.cwd());
    if (tool === "Bash" || tool === "PowerShell") {
      checkCommand(String(args.command ?? ""));
    } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      checkFileEdit();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(
      `guard-target hook failed: ${message}. The action is refused: a hook that can't check lets nothing through. Fix the hook or the input; don't work around it.`,
    );
    process.exit(2);
  }
}

/**
 * The target, plus every repo marked reviewed in `factory.json` (or `FAULTFORGE_CONFIG`). A missing,
 * broken or wrong config can only fail to add a repo; it can never switch off the target's guard.
 */
function reviewedRepos(): Reviewed[] {
  const repos = [TARGET];
  try {
    const path = process.env.FAULTFORGE_CONFIG ?? join(import.meta.dirname, "../../factory.json");
    const entries: { github?: unknown; path?: unknown; guard?: unknown }[] = Object.values(
      JSON.parse(readFileSync(path, "utf8")).repos ?? {},
    );
    for (const entry of entries) {
      if (entry.guard !== "reviewed" || typeof entry.github !== "string" || typeof entry.path !== "string") continue;
      const known = repos.find((r) => r.github.toLowerCase() === (entry.github as string).toLowerCase());
      if (known) {
        // The config may keep the target's checkout somewhere else; its protection stays either way.
        known.checkout = resolve(LAB_ROOT, entry.path);
        continue;
      }
      const name = entry.github.split("/")[1] ?? entry.github;
      repos.push({
        github: entry.github,
        name,
        folder: basename(entry.path) || name,
        checkout: resolve(LAB_ROOT, entry.path),
      });
    }
  } catch {
    // keep the target alone
  }
  return repos;
}

/** A link GitHub turns into a "mentioned in" event on one of these repos' issues or PRs. */
function linkPattern(repos: Reviewed[]): RegExp | undefined {
  if (!repos.length) return undefined;
  return new RegExp(
    repos.map((r) => `github\\.com/${esc(r.github)}/(issues|pull)/\\d+|${esc(r.name)}#\\d+`).join("|"),
    "i",
  );
}

/**
 * Every GitHub repo (owner/name) a command names as a destination: `--repo`, an API route, or a URL
 * given to `gh` or to `git push/pull/fetch/clone/remote`, anywhere in the command, chained parts and
 * quoted text included. The guard applies the strictest rule over all of them.
 */
function explicitDestinations(command: string): string[] {
  const patterns = [
    /--repo[\s=]+["']?([\w.-]+\/[\w.-]+)/gi,
    /\brepos\/([\w.-]+\/[\w.-]+)\//gi,
    /\bgh\s+(?:pr|issue)\s+\w+\s+["']?https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/"'\s]|$)/gi,
    /\bgit\b[^|;&\n]*\b(?:push|pull|fetch|clone|remote)\b[^|;&\n]*github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/"'\s]|$)/gi,
  ];
  return patterns.flatMap((pattern) => [...command.matchAll(pattern)].map((m) => (m[1] ?? "").toLowerCase()));
}

/**
 * The ways a command moves into a checkout: `cd`, `pushd`, PowerShell's `Set-Location` (or `sl`), each
 * with an optional `-Path`/`-LiteralPath`, `git -C<path>` with or without a space, and `git --work-tree=` /
 * `--git-dir`. The path may be relative, absolute or quoted, and the folder may be followed by a path
 * separator, a quote, whitespace or a shell operator (`;`, `&&`, `|`).
 */
function checkoutPattern(repo: Reviewed, atSegmentStart: boolean): RegExp {
  const folders = [repo.folder, repo.name].map(esc).join("|");
  const lead = atSegmentStart ? "(?:^|[;&|\\n]\\s*)" : "\\b";
  const into = `(?:${lead}(?:cd|pushd|Set-Location|sl)\\s+(?:-(?:Literal)?Path\\s+)?|${lead}git\\s+-C\\s*|${lead}git\\s+--(?:work-tree|git-dir)[=\\s]\\s*)`;
  return new RegExp(`${into}["']?[^\\s"']*(^|[/\\\\])?(${folders})(?=[/\\\\"'\\s;&|)]|$)`, "i");
}

/** True when the command moves into the repo's checkout anywhere in its text, quoted or not: fails closed. */
function entersCheckout(command: string, repo: Reviewed): boolean {
  return checkoutPattern(repo, false).test(command);
}

/**
 * True only when the move into the checkout is a command of its own (at the start of the command or after a
 * shell operator), not words inside a message. The own-ticket link exemption needs this stricter form, so a
 * quoted `Set-Location <target>` in a commit message can't earn it.
 */
function navigatesInto(command: string, repo: Reviewed): boolean {
  return checkoutPattern(repo, true).test(command);
}

/**
 * Runs git in a reviewed checkout and returns its output, or denies when git can't answer: a checkout the
 * guard can't inspect is a checkout it can't clear.
 */
function gitIn(repo: Reviewed, args: string[]): string {
  const result = spawnSync("git", ["-C", repo.checkout, ...args], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) {
    deny(
      `The guard can't inspect ${repo.name}'s pending content (git ${args[0]} failed: ${(result.stderr || result.error?.message || "").trim().split("\n")[0]}), so nothing may be committed or pushed until it can.`,
    );
  }
  return result.stdout;
}

/** The added lines of a unified diff, without the `+` and without the file headers. */
function addedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * The reasons the content about to leave a reviewed checkout would give the lab away, or an empty list.
 * For a commit: every change to tracked files (staged or not, since `-a` commits both) plus every untracked
 * file (a chained `git add` would stage it), by content and by name. For a push: every line and file name
 * added by the commits not yet on `origin/main`. Read from git itself, so it doesn't matter how the content
 * got there: a redirect, a copy, a script, an editor.
 */
function pendingTelltales(repo: Reviewed, moment: "commit" | "push"): { reasons: string[]; where: string } {
  if (!existsSync(join(repo.checkout, ".git"))) return { reasons: [], where: "" };
  if (moment === "commit") {
    const untracked = gitIn(repo, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const contents = untracked.map((file) => {
      const path = join(repo.checkout, file);
      return statSync(path).isFile() ? readFileSync(path, "utf8") : "";
    });
    const names = gitIn(repo, ["diff", "HEAD", "--name-only"]);
    const text = [
      addedLines(gitIn(repo, ["diff", "HEAD", "--unified=0", "--no-color"])),
      names,
      ...untracked,
      ...contents,
    ];
    return { reasons: telltales(text.join("\n")), where: "the changes not yet committed" };
  }
  const range = "origin/main...HEAD";
  const names = gitIn(repo, ["diff", range, "--name-only"]);
  const text = [addedLines(gitIn(repo, ["diff", range, "--unified=0", "--no-color"])), names];
  return { reasons: telltales(text.join("\n")), where: "the commits not yet on origin/main" };
}

/**
 * Before any `git commit` or `git push`, wherever it runs, refuses if a reviewed checkout holds pending
 * content that names the lab or the bug. This is the check that doesn't depend on reading the command right.
 */
function checkPendingContent(command: string) {
  const commits = /\bgit\b[^|;&\n]*\bcommit\b/.test(command);
  const pushes = /\bgit\b[^|;&\n]*\bpush\b/.test(command);
  for (const moment of [commits && "commit", pushes && "push"] as const) {
    if (!moment) continue;
    for (const repo of REVIEWED) {
      const pending = pendingTelltales(repo, moment);
      if (pending.reasons.length) {
        deny(
          `${repo.name} holds content that would give the lab away in ${pending.where} (${pending.reasons.join(", ")}). Remove it from the checkout before any commit or push.`,
        );
      }
    }
  }
}

/**
 * True when the command runs more than one command: `;`, `&&`, `||`, `|`, a background `&`, a new
 * line, or a command substitution. Quoted text and heredoc bodies may hold those characters as plain
 * text, so they are ignored, except double-quoted text that runs `$(...)` or backticks.
 */
function isChained(command: string): boolean {
  const bare = command
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => (/^"[\s\S]*(\$\(|`)/.test(quoted) ? quoted : " "));
  return /;|&&|\|\||\||(?<![&>])&(?![&>])|\n|\$\(|`/.test(bare.trim());
}

/** True when a local path is inside the repo's checkout folder (whole folder names only). */
function inCheckout(path: string, repo: Reviewed): boolean {
  return [repo.folder, repo.name].some((folder) => new RegExp(`(^|[/\\\\])${esc(folder)}([/\\\\]|$)`, "i").test(path));
}

function checkCommand(command: string) {
  const writes =
    /\bgit\b[^|;&\n]*\b(commit|push|tag)\b/.test(command) ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen)\b/.test(command) ||
    (/\bgh\s+api\b/.test(command) && /(-X\s*(POST|PATCH|PUT)|\s-[fF]\s|--field|--raw-field|--input)/.test(command));

  // What would travel: the content pending in every reviewed checkout, read from git, whatever this
  // command's text says about where it runs.
  checkPendingContent(command);

  // Every reviewed repo the command touches, by any part of it: a named destination, or a move into its
  // checkout. The folder the command runs in only counts when it names no destination at all (say,
  // `git commit` inside a checkout), so a post from there to another repo is judged by where it goes.
  const destinations = explicitDestinations(command);
  const runsIn = (r: Reviewed) => inCheckout(cwd, r) || entersCheckout(command, r);

  // Reading a shell command with patterns can't be complete, so a command that writes and involves
  // more than one repo must be split: each part then gets judged on its own. A chain that stays in
  // one repo (cd target && git add && git commit && git push) is fine.
  if (writes && isChained(command)) {
    const involved = new Set(destinations);
    for (const r of REVIEWED) if (runsIn(r)) involved.add(r.github.toLowerCase());
    if (involved.size > 1) {
      deny(
        "This command writes and involves more than one repo. Run the parts for different repos as separate commands.",
      );
    }
  }

  const touched = REVIEWED.filter(
    (r) =>
      destinations.includes(r.github.toLowerCase()) ||
      entersCheckout(command, r) ||
      (!destinations.length && inCheckout(cwd, r)),
  );
  const repo = touched[0];
  if (!repo) {
    if (writes) checkLinks(command, REVIEWED);
    return;
  }

  if (/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    deny(`Force pushes to ${repo.name} are not allowed: its history is evidence for recorded cases.`);
  }
  if (!writes) return;

  // A reviewed repo may link to its own tickets only when the command really runs in its checkout (the
  // hook's folder, or a `cd`/`git -C` that is a command of its own) and goes nowhere else. Words in a
  // message (a quoted --repo or a quoted Set-Location, say) can't grant that.
  const onlyItself =
    touched.length === 1 &&
    (inCheckout(cwd, repo) || navigatesInto(command, repo)) &&
    destinations.every((d) => d === repo.github.toLowerCase());
  checkLinks(command, onlyItself ? REVIEWED.filter((r) => r !== repo) : REVIEWED);

  const text = [stripReviewedNames(command), ...referencedFiles(command)].join("\n");
  const found = telltales(text);
  if (found.length) {
    deny(
      `This would put a hint into ${repo.name} (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`,
    );
  }
}

function checkFileEdit() {
  const path = resolve(cwd, String(args.file_path ?? args.notebook_path ?? ""));
  const repo = REVIEWED.find((r) => inCheckout(path, r));
  if (!repo) return;
  const text = [
    args.content,
    args.new_string,
    args.new_source,
    ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string),
  ]
    .filter(Boolean)
    .join("\n");
  const found = telltales(stripReviewedNames(text));
  if (found.length) {
    deny(
      `This edit would put a hint into ${repo.name} (${found.join(", ")}). Keep its files free of any mention of the lab.`,
    );
  }
}

/**
 * Links only go one way: posts may name reviewed work as plain text ("target 3"), but never link to
 * one of `repos`' issues or PRs. A link would show on that repo's timeline, where its reviewer reads it.
 */
function checkLinks(command: string, repos: Reviewed[]) {
  // Only when `gh pr create` is a command being run, not words inside a message.
  if (/(?:^|[;&|\n]\s*)gh\s+pr\s+create\b[^|;&\n"']*\s--fill(-first|-verbose)?\b/.test(command)) {
    deny("gh pr create --fill posts commit text the guard can't check. Pass --title and --body instead.");
  }
  const posted = postedArguments(command);
  // Text read from stdin (a pipe or heredoc) or built from shell variables is in the command
  // itself, not in the extracted arguments, so check the whole command for those.
  const indirect = /(\s-F|--file|--body-file|--input)[\s=]+-(\s|$)/.test(command) || posted.some((p) => /[$`]/.test(p));
  const text = [...(indirect ? [command] : posted), ...referencedFiles(command)].join("\n");
  const linked = repos.find((r) => linkPattern([r])?.test(text));
  if (linked) {
    deny(
      `This would link to the target (${linked.name}) from here, and it would show that on its timeline. Name the work as plain text instead, like "target 3".`,
    );
  }
}

/**
 * Repo names are allowed where they identify a repo: in paths and `owner/name`. Elsewhere they are
 * ordinary words, so a repo named after a forbidden word can't hide that word in a message.
 */
function stripReviewedNames(text: string): string {
  const repoWords = REVIEWED.flatMap((r) => [r.name, r.folder]).map(esc);
  const identifies = new RegExp(`faultforge|${repoWords.join("|")}`, "i");
  return text.replace(/[^\s"'`]*[/\\][^\s"'`]*/g, (token) => (identifies.test(token) ? " " : token));
}

/**
 * The text a command would post: commit messages, titles, bodies and API fields. Other parts of
 * the command, such as a script that edits a file, are left out.
 */
function postedArguments(command: string): string[] {
  const flag = /(?:^|\s)(?:-m|--message|-t|--title|-b|--body|(?:-f|-F|--field|--raw-field)\s+\w+=)[\s=]*/;
  const value = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/;
  const pattern = new RegExp(`${flag.source}(?:${value.source})`, "g");
  return [...command.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/**
 * For each position in the command, whether it looks to sit inside quoted text or a heredoc body. This
 * is a pattern over shell text, so fake quoting can fool it (a `<<X` in a comment, an escaped quote).
 * It therefore only ever softens a decision: a missing file behind a flag written here is words in a
 * message rather than a deny. It never stops a file that exists from being read.
 */
function quotedPositions(command: string): boolean[] {
  const quoted = new Array<boolean>(command.length).fill(false);
  // A quoted span starts at an unescaped quote: `printf \"` opens nothing.
  const spans = [/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, /(?<!\\)"(?:[^"\\]|\\.)*"|(?<!\\)'[^']*'/g];
  for (const span of spans) {
    for (const m of command.matchAll(span)) {
      for (let i = m.index; i < m.index + m[0].length; i++) quoted[i] = true;
    }
  }
  return quoted;
}

/**
 * Contents of message or body files the command reads, e.g. `git commit -F msg.txt` or `--body-file`.
 * Every file that exists behind such a flag is read, however the flag is quoted: a file the command
 * would really post exists when the hook runs, and reading one more file is harmless. A `gh api` field
 * (`-F name=value`) is text unless its value is `@file`, which gh reads from that file; a file really
 * named `name=value` is read too, because `git commit -F` would read it. A flag whose file doesn't
 * exist is words in a message when it sits in quoted text or a heredoc body, and otherwise a deny: the
 * guard can't check what would be posted, so nothing is posted. A file that exists but can't be read
 * throws, and the hook then fails closed.
 */
function referencedFiles(command: string): string[] {
  const files: string[] = [];
  const quoted = quotedPositions(command);
  const ghApi = /\bgh\s+api\b/.test(command);
  // A bare file name ends at whitespace, a quote or a shell separator: `-F msg.txt; echo` names msg.txt.
  for (const match of command.matchAll(
    /(\s-F|--file|--body-file|--input)[\s=]+(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))/g,
  )) {
    let file = match[2] ?? match[3] ?? match[4];
    if (!file || file === "-") continue;
    const field = ghApi ? /^[\w-]+=(.*)$/s.exec(file) : null;
    if (field && !existsSync(resolve(cwd, file))) {
      if (!field[1]?.startsWith("@")) continue;
      file = field[1].slice(1);
      if (!file || file === "-") continue;
    }
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    if (existsSync(path)) {
      files.push(readFileSync(path, "utf8"));
      continue;
    }
    // The flag's own position: for ` -F` that is after the leading space.
    const flagAt = match.index + match[0].length - match[0].trimStart().length;
    if (quoted[flagAt]) continue;
    deny(
      `This command would post the contents of ${file}, which doesn't exist, so the guard can't check it. Write the file first, then run the command.`,
    );
  }
  return files;
}

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}
