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
 * (cd, pushd, Set-Location, git -C, git --work-tree), or runs from inside it. Which repos those are, and
 * how a checkout is recognised, is in guard-repos.ts.
 * And everywhere else it blocks issues, PRs and commit messages that link to a reviewed repo.
 *
 * `decide()` takes the hook payload as text and returns the decision without printing or exiting, so the
 * tests call it in-process. Run as `node <this file>`, `main()` reads the payload from stdin and answers:
 * a deny decision as JSON, nothing to allow, or exit 2 with one line on stderr when it couldn't check.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";
import { blankQuoted, chainProblem, pendingCommit, pendingPush, Uninspectable } from "./guard-content.ts";
import {
  entersCheckout,
  esc,
  inCheckout,
  linkPattern,
  navigatesInto,
  type Reviewed,
  reviewedRepos,
} from "./guard-repos.ts";
import { ALLOW, type Decision, firstLine, hookAnswer, isEntry, readStdin, respond } from "./hook-io.ts";

/** What one decision is made against: the folder the tool runs in, and the repos under guard. */
interface Context {
  cwd: string;
  reviewed: Reviewed[];
}

/** A tool's input as parsed from the payload: whatever Claude Code sent. */
type ToolInput = ReturnType<typeof JSON.parse>;

/** Thrown by `deny()` and turned into a deny decision by `decide()`. */
class Denied extends Error {}

/**
 * The decision for one hook payload. Fails closed: an exception (unreadable input, a body file that is a
 * folder) is a blocking error, never an allow, because Claude Code treats a hook that crashes as a
 * non-blocking error and runs the tool anyway. `env` supplies `FAULTFORGE_CONFIG`.
 */
export function decide(stdin: string, env: NodeJS.ProcessEnv = process.env): Decision {
  try {
    const input = JSON.parse(stdin);
    const tool = String(input.tool_name ?? "");
    const args: ToolInput = input.tool_input ?? {};
    const ctx: Context = {
      cwd: String(input.cwd ?? process.cwd()),
      reviewed: reviewedRepos(env.FAULTFORGE_CONFIG),
    };
    if (tool === "Bash" || tool === "PowerShell") {
      checkCommand(ctx, String(args.command ?? ""));
    } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      checkFileEdit(ctx, args);
    }
    return ALLOW;
  } catch (error) {
    if (error instanceof Denied) return { kind: "deny", reason: error.message };
    return failed(error);
  }
}

/** The hook's own failure as a blocking error: the tool call is refused, never let through. */
function failed(error: unknown): Decision {
  return {
    kind: "error",
    message: `guard-target hook failed: ${firstLine(error)}. The action is refused: a hook that can't check lets nothing through. Fix the hook or the input; don't work around it.`,
  };
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
 * Before any `git commit` or `git push`, wherever it runs, refuses if a reviewed checkout holds pending
 * content that names the lab or the bug (see guard-content.ts). This is the check that doesn't depend on
 * reading the command right. A reviewed checkout the guard can't find is skipped unless the command is
 * aimed at it; one git can't read is a deny.
 */
function checkPendingContent(ctx: Context, command: string, touched: Reviewed[]) {
  const commits = /\bgit\b[^|;&\n]*\bcommit\b/.test(command);
  const pushes = /\bgit\b[^|;&\n]*\bpush\b/.test(command);
  const forceIgnored = /\badd\b[^|;&\n]*\s(-\w*f\w*|--force)\b/.test(command);
  for (const moment of [commits && "commit", pushes && "push"] as const) {
    if (!moment) continue;
    for (const repo of ctx.reviewed) {
      if (!existsSync(join(repo.checkout, ".git"))) {
        if (touched.includes(repo)) {
          deny(
            `The guard can't find ${repo.name}'s checkout at ${repo.checkout} (from factory.json), so it can't check what this ${moment} would carry. Fix the path before committing or pushing there.`,
          );
        }
        continue;
      }
      try {
        const pending = moment === "commit" ? pendingCommit(repo.checkout, forceIgnored) : pendingPush(repo.checkout);
        if (pending.reasons.length) {
          deny(
            `${repo.name} holds content that would give the lab away in ${pending.where} (${pending.reasons.join(", ")}). Remove it from the checkout before any commit or push.`,
          );
        }
      } catch (error) {
        if (!(error instanceof Uninspectable)) throw error;
        deny(
          `The guard can't inspect ${repo.name}'s pending content (${error.message}), so nothing may be committed or pushed until it can.`,
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
  return /;|&&|\|\||\||(?<![&>])&(?![&>])|\n|\$\(|`/.test(blankQuoted(command).trim());
}

function checkCommand(ctx: Context, command: string) {
  const { cwd, reviewed } = ctx;
  const writes =
    /\bgit\b[^|;&\n]*\b(commit|push|tag)\b/.test(command) ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen)\b/.test(command) ||
    (/\bgh\s+api\b/.test(command) && /(-X\s*(POST|PATCH|PUT)|\s-[fF]\s|--field|--raw-field|--input)/.test(command));

  // Every reviewed repo the command touches, by any part of it: a named destination, or a move into its
  // checkout. The folder the command runs in only counts when it names no destination at all (say,
  // `git commit` inside a checkout), so a post from there to another repo is judged by where it goes.
  const destinations = explicitDestinations(command);
  const runsIn = (r: Reviewed) => inCheckout(cwd, r) || entersCheckout(command, r);
  const touched = reviewed.filter(
    (r) =>
      destinations.includes(r.github.toLowerCase()) ||
      entersCheckout(command, r) ||
      (!destinations.length && inCheckout(cwd, r)),
  );

  // Reading a shell command with patterns can't be complete, so a command that writes and involves
  // more than one repo must be split: each part then gets judged on its own. A chain that stays in
  // one repo (cd target && git add && git commit && git push) is fine.
  if (writes && isChained(command)) {
    const involved = new Set(destinations);
    for (const r of reviewed) if (runsIn(r)) involved.add(r.github.toLowerCase());
    if (involved.size > 1) {
      deny(
        "This command writes and involves more than one repo. Run the parts for different repos as separate commands.",
      );
    }
  }

  const repo = touched[0];
  if (!repo) {
    if (writes) checkLinks(ctx, command, reviewed);
    // Even from elsewhere, a commit or push is checked against every reviewed checkout's pending content.
    checkPendingContent(ctx, command, touched);
    return;
  }

  if (/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    deny(`Force pushes to ${repo.name} are not allowed: its history is evidence for recorded cases.`);
  }

  // Inside a reviewed checkout, a chain that mentions git may hold only steps that can't change the
  // checkout's content behind the guard's back (it looks before the command runs): no copies, redirects,
  // scripts or shell functions in the same command as a commit or push. Those run first, on their own.
  if (isChained(command) && /\bgit\b/.test(command)) {
    const step = chainProblem(command);
    if (step !== undefined) {
      deny(
        `In ${repo.name}, a command that writes files or hides a command ("${step.slice(0, 60)}") must run on its own, and the commit or push in a separate command: the guard checks the checkout's content before a command runs, and can't see what an earlier part of the same command would write.`,
      );
    }
  }
  if (!writes) return;

  // A reviewed repo may link to its own tickets only when the command really runs in its checkout (the
  // hook's folder, or a `cd`/`git -C` that is a command of its own) and goes nowhere else. Words in a
  // message (a quoted --repo or a quoted Set-Location, say) can't grant that.
  const onlyItself =
    touched.length === 1 &&
    (inCheckout(cwd, repo) || navigatesInto(command, repo)) &&
    destinations.every((d) => d === repo.github.toLowerCase());
  checkLinks(ctx, command, onlyItself ? reviewed.filter((r) => r !== repo) : reviewed);

  // Each piece is judged on its own: a title ending in one word and a body starting with the next must
  // not join into a phrase that neither field holds. A commit is the exception: git joins every `-m` and
  // `-F` into one message, so those are also judged together.
  const pieces = [stripReviewedNames(reviewed, command), ...postedText(command), ...referencedFiles(cwd, command)];
  for (const commit of commitSteps(command)) {
    pieces.push([...commitMessages(commit), ...referencedFiles(cwd, commit)].join("\n"));
  }
  const found = [...new Set(pieces.flatMap((piece) => telltales(piece)))];
  if (found.length) {
    deny(
      `This would put a hint into ${repo.name} (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`,
    );
  }

  // The command's own text is clean; now what would travel: the content pending in every reviewed
  // checkout, read from git, whatever the text says about where it runs.
  checkPendingContent(ctx, command, touched);
}

function checkFileEdit(ctx: Context, args: ToolInput) {
  const path = resolve(ctx.cwd, String(args.file_path ?? args.notebook_path ?? ""));
  const repo = ctx.reviewed.find((r) => inCheckout(path, r));
  if (!repo) return;
  const text = [
    args.content,
    args.new_string,
    args.new_source,
    ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string),
  ]
    .filter(Boolean)
    .join("\n");
  const found = telltales(text);
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
function checkLinks(ctx: Context, command: string, repos: Reviewed[]) {
  // Only when `gh pr create` is a command being run, not words inside a message.
  if (/(?:^|[;&|\n]\s*)gh\s+pr\s+create\b[^|;&\n"']*\s--fill(-first|-verbose)?\b/.test(command)) {
    deny("gh pr create --fill posts commit text the guard can't check. Pass --title and --body instead.");
  }
  const posted = postedArguments(command);
  // Text read from stdin (a pipe or heredoc) or built from shell variables is in the command
  // itself, not in the extracted arguments, so check the whole command for those.
  const indirect = /(\s-F|--file|--body-file|--input)[\s=]+-(\s|$)/.test(command) || posted.some((p) => /[$`]/.test(p));
  const text = [...(indirect ? [command] : posted), ...referencedFiles(ctx.cwd, command)].join("\n");
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
function stripReviewedNames(reviewed: Reviewed[], text: string): string {
  const repoWords = reviewed.flatMap((r) => [r.name, r.folder]).map(esc);
  const identifies = new RegExp(`faultforge|${repoWords.join("|")}`, "i");
  return text.replace(/[^\s"'`]*[/\\][^\s"'`]*/g, (token) => (identifies.test(token) ? " " : token));
}

/**
 * The text a command would post, as written: flag values and heredoc bodies, or the whole command when
 * the text is piped in or built from shell variables. Nothing in it identifies a repo to the shell, so no
 * name is stripped from it: a lab link or `owner/name` in a message is a hint like any other.
 */
function postedText(command: string): string[] {
  // Flags are read outside heredoc bodies: an option-looking line in one is text, not an argument.
  const spans = heredocSpans(command);
  let outside = command;
  for (const span of [...spans].reverse()) outside = outside.slice(0, span.start) + outside.slice(span.end);
  const posted = postedArguments(outside);
  const heredocs = spans.map((span) => command.slice(span.start, span.end));
  const stdin = /(\s-F|--file|--body-file|--input)[\s=]+-(\s|$)/.test(command);
  // A heredoc is posted only when the command reads a body from stdin; any other heredoc belongs to
  // another command, and the whole-command check already reads it as before. When stdin has more than
  // one heredoc to choose from, all of them count: refusing a clean post is the safe mistake.
  if (stdin && heredocs.length) return [...posted, ...heredocs];
  // The flag values are kept beside the whole command: a title next to a piped body is posted too.
  if (!stdin && !posted.some((p) => /[$`]/.test(p))) return posted;
  return [blankLocalPaths(command, true), ...posted.map((value) => blankLocalPaths(value, false))];
}

/**
 * Where each heredoc body sits in the command, as the shell reads it. The delimiter is the word after
 * `<<` (or `<<-`) with its quoting removed: quote marks and backslashes quote, so `'EOF'`, `\EOF` and
 * `E\OF` all mean `EOF`, and `EOF-` is not `EOF`. The body starts on the next line and ends before the
 * first line that is the delimiter alone; `<<-` lets tabs, never spaces, come before it. A body with no
 * such line runs to the end of the command.
 */
function heredocSpans(command: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const opener = /<<(-?)[ \t]*((?:\\.|[^\s<>|;&()])+)/g;
  let match: RegExpExecArray | null = opener.exec(command);
  while (match) {
    const tabs = match[1] === "-";
    const delimiter = (match[2] ?? "").replace(/\\(.)/g, "$1").replace(/["']/g, "");
    const lineEnd = command.indexOf("\n", match.index);
    if (lineEnd < 0 || !delimiter) break;
    const start = lineEnd + 1;
    let at = start;
    let end = command.length;
    while (at <= command.length) {
      const next = command.indexOf("\n", at);
      const line = command.slice(at, next < 0 ? command.length : next);
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) {
        end = at;
        break;
      }
      if (next < 0) break;
      at = next + 1;
    }
    spans.push({ start, end });
    opener.lastIndex = end;
    match = opener.exec(command);
  }
  return spans;
}

/**
 * The text with the files a body is read from blanked: the path after `cat`, `type` or `Get-Content`
 * (`gc`), and in a whole command after an input redirect `<`. Only those: path-shaped text anywhere else
 * may be the message itself, and inside a quoted value a `<` is just text.
 */
function blankLocalPaths(text: string, redirects: boolean): string {
  const reader = redirects ? /\b(?:cat|type|Get-Content|gc)\s+|<\s*/ : /\b(?:cat|type|Get-Content|gc)\s+/;
  return text.replace(new RegExp(`(${reader.source})(["']?)[^\\s"'\`;&|<>()]+\\2`, "gi"), "$1 ");
}

/** Every part of a chained command that runs `git commit`, each up to the next shell operator. */
function commitSteps(command: string): string[] {
  return [...command.matchAll(/\bgit\b[^|;&\n]*\bcommit\b[^|;&\n]*/g)].map((m) => m[0]);
}

/**
 * Every message value in one `git commit` step, `-m`, `--message`, or `m` at the end of combined short
 * flags such as `-am`: git joins them into one message.
 */
function commitMessages(step: string): string[] {
  const pattern = /(?:^|\s)(?:-[A-Za-z]*m|--message)(?=[\s="']|$)[\s=]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
  return [...step.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
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
 * Contents of message or body files the command reads, e.g. `git commit -F msg.txt` or `--body-file`,
 * with relative names resolved from `cwd`. Every file that exists behind such a flag is read, however the
 * flag is quoted: a file the command would really post exists when the hook runs, and reading one more
 * file is harmless. A `gh api` field (`-F name=value`) is text unless its value is `@file`, which gh reads
 * from that file; a file really named `name=value` is read too, because `git commit -F` would read it. A
 * flag whose file doesn't exist is words in a message when it sits in quoted text or a heredoc body, and
 * otherwise a deny: the guard can't check what would be posted, so nothing is posted. A file that exists
 * but can't be read throws, and the hook then fails closed.
 */
function referencedFiles(cwd: string, command: string): string[] {
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

/** Ends the check with a deny; `decide()` turns it into the decision. */
function deny(reason: string): never {
  throw new Denied(reason);
}

function main() {
  respond(hookAnswer(readStdin, decide, failed));
}

if (isEntry(import.meta.url)) main();
