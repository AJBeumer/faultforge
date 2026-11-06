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
import { isAbsolute, join, resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";

interface Reviewed {
  /** owner/name on GitHub */
  github: string;
  /** The repo name, which is also its local folder name. */
  name: string;
}

const REVIEWED = reviewedRepos();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A link GitHub turns into a "mentioned in" event on a reviewed repo's issue or PR. */
const REVIEWED_LINK = new RegExp(
  REVIEWED.map((r) => `github\\.com/${esc(r.github)}/(issues|pull)/\\d+|${esc(r.name)}#\\d+`).join("|"),
  "i",
);

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
 * The reviewed repos from `factory.json` (or `FAULTFORGE_CONFIG`). If the file can't be read, the
 * target as it was protected before the config existed: a broken config must never switch the guard off.
 */
function reviewedRepos(): Reviewed[] {
  try {
    const path = process.env.FAULTFORGE_CONFIG ?? join(import.meta.dirname, "../../factory.json");
    const repos: { github: string; guard: string }[] = Object.values(JSON.parse(readFileSync(path, "utf8")).repos);
    const reviewed = repos
      .filter((r) => r.guard === "reviewed")
      .map((r) => ({ github: r.github, name: r.github.split("/")[1] ?? r.github }));
    if (reviewed.length) return reviewed;
  } catch {
    // fall through to the safe default
  }
  return [{ github: "AJBeumer/faultforge-target", name: "faultforge-target" }];
}

function checkCommand(command: string) {
  const writes =
    /\bgit\b[^|;&\n]*\b(commit|push|tag)\b/.test(command) ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen)\b/.test(command) ||
    (/\bgh\s+api\b/.test(command) && /(-X\s*(POST|PATCH|PUT)|\s-[fF]\s|--field|--raw-field|--input)/.test(command));

  const repo = REVIEWED.find((r) => actsOn(command, r));
  if (!repo) {
    if (writes) checkOneWay(command);
    return;
  }

  if (/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    deny(`Force pushes to ${repo.name} are not allowed: its history is evidence for recorded cases.`);
  }
  if (!writes) return;

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
  const repo = REVIEWED.find((r) => new RegExp(esc(r.name), "i").test(path));
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
  const name = esc(repo.name);
  const github = esc(repo.github);
  return (
    new RegExp(name, "i").test(cwd) ||
    new RegExp(`\\b(cd|git\\s+-C)\\s+["']?[^\\s"']*${name}`, "i").test(command) ||
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
 * Links only go one way: this repository may name reviewed work as plain text ("target 3"), but its
 * issues, PRs and commits never link to a reviewed repo's issue or PR. A link would show on that
 * repo's timeline, where its reviewer reads it.
 */
function checkOneWay(command: string) {
  // Only when `gh pr create` is a command being run, not words inside a message.
  if (/(?:^|[;&|\n]\s*)gh\s+pr\s+create\b[^|;&\n"']*\s--fill(-first|-verbose)?\b/.test(command)) {
    deny("gh pr create --fill posts commit text the guard can't check. Pass --title and --body instead.");
  }
  const posted = postedArguments(command);
  // Text read from stdin (a pipe or heredoc) or built from shell variables is in the command
  // itself, not in the extracted arguments, so check the whole command for those.
  const indirect = /(\s-F|--file|--body-file|--input)[\s=]+-(\s|$)/.test(command) || posted.some((p) => /[$`]/.test(p));
  const text = [...(indirect ? [command] : posted), ...referencedFiles(command)].join("\n");
  if (REVIEWED_LINK.test(text)) {
    deny(
      'This would link to the target from FaultForge, and the target would show it on its timeline. Name target work as plain text instead, like "target 3".',
    );
  }
}

/** The reviewed repos' own names and local paths are allowed; mentions of the lab in prose are not. */
function stripReviewedNames(text: string): string {
  let stripped = text.replace(/[^\s"'`]*[/\\][^\s"'`]*/g, (token) => (/faultforge/i.test(token) ? " " : token));
  for (const repo of REVIEWED) stripped = stripped.replace(new RegExp(esc(repo.name), "gi"), " ");
  return stripped;
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
