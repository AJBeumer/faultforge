/**
 * Claude Code PreToolUse hook. Keeps the reviewed repositories free of hints for the reviewer.
 *
 * The reviewed repos are the ones with `"guard": "reviewed"` in `factory.json`. For each, it blocks:
 *  - force pushes
 *  - commits, pushes, PRs, comments and API writes whose text names the lab or the bug
 *  - file edits whose new content does the same
 * And everywhere else it blocks issues, PRs and commit messages that link to a reviewed repo.
 *
 * Reads the hook payload on stdin. Prints a deny decision as JSON, or nothing to allow.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";

interface Reviewed {
  /** owner/name on GitHub */
  github: string;
  /** The repo name on GitHub. */
  name: string;
  /** The local checkout's folder name, from its configured path. */
  folder: string;
}

/** Always protected, whatever the config says: the config can add reviewed repos, never remove this one. */
const TARGET: Reviewed = {
  github: "AJBeumer/faultforge-target",
  name: "faultforge-target",
  folder: "faultforge-target",
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
      if (repos.some((r) => r.github.toLowerCase() === (entry.github as string).toLowerCase())) continue;
      const name = entry.github.split("/")[1] ?? entry.github;
      repos.push({ github: entry.github, name, folder: basename(entry.path) || name });
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

/** True when the command moves into the repo's checkout itself (`cd` or `git -C`). */
function entersCheckout(command: string, repo: Reviewed): boolean {
  const folders = [repo.folder, repo.name].map(esc).join("|");
  return new RegExp(`\\b(cd|git\\s+-C)\\s+["']?[^\\s"']*(^|[/\\\\])?(${folders})(?=[/\\\\"'\\s]|$)`, "i").test(command);
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

  // Every reviewed repo the command touches, by any part of it: a named destination, or a `cd`/`git -C`
  // into its checkout. The folder the command runs in only counts when it names no destination at
  // all (say, `git commit` inside a checkout), so a post from there to another repo is judged by
  // where it goes.
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

  // A reviewed repo may link to its own tickets only when the command really runs in its checkout
  // and goes nowhere else. Words in a message (a quoted --repo, say) can't grant that.
  const onlyItself = touched.length === 1 && runsIn(repo) && destinations.every((d) => d === repo.github.toLowerCase());
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
 * Contents of message or body files the command reads, e.g. `git commit -F msg.txt`. A `gh api` field
 * (`-F name=value`) is text, not a file, unless its value is `@file`, which gh reads from that file. A
 * file that doesn't exist is a deny: the guard can't check what would be posted, so nothing is posted.
 * One that exists but can't be read throws, and the hook then fails closed.
 */
function referencedFiles(command: string): string[] {
  const files: string[] = [];
  for (const match of command.matchAll(
    /(?:\s-F|--file|--body-file|--input)[\s=]+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g,
  )) {
    let file = match[1] ?? match[2] ?? match[3];
    if (!file || file === "-") continue;
    const field = /^[\w-]+=(.*)$/s.exec(file);
    if (field) {
      if (!field[1]?.startsWith("@")) continue;
      file = field[1].slice(1);
      if (!file || file === "-") continue;
    }
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    if (!existsSync(path)) {
      deny(
        `This command would post the contents of ${file}, which doesn't exist, so the guard can't check it. Write the file first, then run the command.`,
      );
    }
    files.push(readFileSync(path, "utf8"));
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
