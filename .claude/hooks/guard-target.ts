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

const input = JSON.parse(readFileSync(0, "utf8"));
const tool: string = input.tool_name ?? "";
const args = input.tool_input ?? {};
const cwd: string = input.cwd ?? process.cwd();

if (tool === "Bash" || tool === "PowerShell") {
  checkCommand(String(args.command ?? ""));
} else if (["Write", "Edit", "MultiEdit"].includes(tool)) {
  checkFileEdit();
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
 * The GitHub repo (owner/name) a command explicitly sends to: `--repo`, an API route, or a URL given
 * to `gh` or to `git push/pull/fetch/clone/remote`. Undefined when the command names none.
 */
function explicitDestination(command: string): string | undefined {
  const patterns = [
    /--repo[\s=]+["']?([\w.-]+\/[\w.-]+)/i,
    /\brepos\/([\w.-]+\/[\w.-]+)\//i,
    /\bgh\s+(?:pr|issue)\s+\w+\s+["']?https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/"'\s]|$)/i,
    /\bgit\b[^|;&\n]*\b(?:push|pull|fetch|clone|remote)\b[^|;&\n]*github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/"'\s]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(command)?.[1];
    if (match) return match;
  }
  return undefined;
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

  // Where a post goes decides the rules, not the folder it's sent from. Only a command that names
  // no destination (say, `git commit` in a checkout) is judged by its folder.
  const destination = explicitDestination(command);
  const repo = destination
    ? REVIEWED.find((r) => r.github.toLowerCase() === destination.toLowerCase())
    : REVIEWED.find((r) => actsOn(command, r));
  if (!repo) {
    if (writes) checkLinks(command, REVIEWED);
    return;
  }

  if (/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    deny(`Force pushes to ${repo.name} are not allowed: its history is evidence for recorded cases.`);
  }
  if (!writes) return;

  // A reviewed repo may link to itself, never to another reviewed repo.
  checkLinks(
    command,
    REVIEWED.filter((r) => r !== repo),
  );

  const text = [stripReviewedNames(command), ...referencedFiles(command)].join("\n");
  const found = telltales(text);
  if (found.length) {
    deny(
      `This would put a hint into ${repo.name} (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`,
    );
  }
}

function checkFileEdit() {
  const path = resolve(cwd, String(args.file_path ?? ""));
  const repo = REVIEWED.find((r) => inCheckout(path, r));
  if (!repo) return;
  const text = [args.content, args.new_string, ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string)]
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
 * True when the command runs in, or acts on, the reviewed repo. A URL that is only part of the
 * text (say, a link written into a file here) doesn't count; one given to `gh` or `git` as the
 * thing to act on does.
 */
function actsOn(command: string, repo: Reviewed): boolean {
  const folders = [repo.folder, repo.name].map(esc).join("|");
  const github = esc(repo.github);
  return (
    inCheckout(cwd, repo) ||
    new RegExp(`\\b(cd|git\\s+-C)\\s+["']?[^\\s"']*(^|[/\\\\])?(${folders})(?=[/\\\\"'\\s]|$)`, "i").test(command) ||
    new RegExp(`--repo[\\s=]+["']?${github}\\b`, "i").test(command) ||
    new RegExp(`repos/${github}/`, "i").test(command) ||
    new RegExp(
      `\\bgit\\b[^|;&\\n]*\\b(push|pull|fetch|clone|remote)\\b[^|;&\\n]*github\\.com[/:]${github}\\b`,
      "i",
    ).test(command) ||
    new RegExp(`\\bgh\\s+(pr|issue)\\s+\\w+\\s+["']?https://github\\.com/${github}\\b`, "i").test(command)
  );
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

/** Contents of message or body files the command reads, e.g. `git commit -F msg.txt`. */
function referencedFiles(command: string): string[] {
  const files: string[] = [];
  for (const match of command.matchAll(
    /(?:\s-F|--file|--body-file|--input)[\s=]+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g,
  )) {
    const file = match[1] ?? match[2] ?? match[3];
    if (!file || file === "-") continue;
    const path = isAbsolute(file) ? file : resolve(cwd, file);
    if (existsSync(path)) files.push(readFileSync(path, "utf8"));
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
