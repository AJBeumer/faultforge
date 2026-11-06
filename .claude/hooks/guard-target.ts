/**
 * Claude Code PreToolUse hook. Keeps the target repository free of hints for the reviewer.
 *
 * Blocks, for faultforge-target only:
 *  - force pushes
 *  - commits, pushes, PRs, comments and API writes whose text names the lab or the bug
 *  - file edits whose new content does the same
 *
 * Reads the hook payload on stdin. Prints a deny decision as JSON, or nothing to allow.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";

const TARGET = /faultforge-target/i;
/** A link GitHub turns into a "mentioned in" event on a target issue or PR. */
const TARGET_LINK = /github\.com\/AJBeumer\/faultforge-target\/(issues|pull)\/\d+|faultforge-target#\d+/i;

const input = JSON.parse(readFileSync(0, "utf8"));
const tool: string = input.tool_name ?? "";
const args = input.tool_input ?? {};
const cwd: string = input.cwd ?? process.cwd();

if (tool === "Bash" || tool === "PowerShell") {
  checkCommand(String(args.command ?? ""));
} else if (["Write", "Edit", "MultiEdit"].includes(tool)) {
  checkFileEdit();
}

function checkCommand(command: string) {
  const writes =
    /\bgit\b[^|;&\n]*\b(commit|push|tag)\b/.test(command) ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen)\b/.test(command) ||
    (/\bgh\s+api\b/.test(command) && /(-X\s*(POST|PATCH|PUT)|\s-[fF]\s|--field|--raw-field|--input)/.test(command));

  if (!targetsTargetRepo(command)) {
    if (writes) checkOneWay(command);
    return;
  }

  if (/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    deny("Force pushes to faultforge-target are not allowed: its history is evidence for recorded cases.");
  }
  if (!writes) return;

  const text = [stripTargetNames(command), ...referencedFiles(command)].join("\n");
  const found = telltales(text);
  if (found.length) {
    deny(
      `This would put a hint into faultforge-target (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`,
    );
  }
}

function checkFileEdit() {
  const path = String(args.file_path ?? "");
  if (!TARGET.test(resolve(cwd, path))) return;
  const text = [args.content, args.new_string, ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string)]
    .filter(Boolean)
    .join("\n");
  const found = telltales(stripTargetNames(text));
  if (found.length) {
    deny(
      `This edit would put a hint into faultforge-target (${found.join(", ")}). Keep target files free of any mention of the lab.`,
    );
  }
}

/**
 * True when the command runs in, or acts on, the target repository. A target URL that is only
 * part of the text (say, a link written into a file here) doesn't count; one given to `gh` as
 * the thing to act on does.
 */
function targetsTargetRepo(command: string): boolean {
  return (
    TARGET.test(cwd) ||
    /\b(cd|git\s+-C)\s+["']?[^\s"']*faultforge-target/i.test(command) ||
    /--repo[\s=]+["']?AJBeumer\/faultforge-target\b/i.test(command) ||
    /repos\/AJBeumer\/faultforge-target\//i.test(command) ||
    /\bgh\s+(pr|issue)\s+\w+\s+["']?https:\/\/github\.com\/AJBeumer\/faultforge-target\b/i.test(command)
  );
}

/**
 * Links only go one way: this repository may name target work as plain text ("target 3"), but its
 * issues, PRs and commits never link to a target issue or PR. A link would show on the target's
 * timeline, where its reviewer reads it.
 */
function checkOneWay(command: string) {
  const text = [...postedArguments(command), ...referencedFiles(command)].join("\n");
  if (TARGET_LINK.test(text)) {
    deny(
      'This would link to the target from FaultForge, and the target would show it on its timeline. Name target work as plain text instead, like "target 3".',
    );
  }
}

/** The target's own name and local paths are allowed; mentions of the lab in prose are not. */
function stripTargetNames(text: string): string {
  return text
    .replace(/[^\s"'`]*[/\\][^\s"'`]*/g, (token) => (/faultforge/i.test(token) ? " " : token))
    .replace(/faultforge-target/gi, " ");
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
  for (const match of command.matchAll(/(?:\s-F|--file|--body-file|--input)[\s=]+["']?([^\s"']+)/g)) {
    const file = match[1];
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
