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
  if (!targetsTargetRepo(command)) return;

  if (/\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    deny("Force pushes to faultforge-target are not allowed: its history is evidence for recorded cases.");
  }

  const writes =
    /\bgit\b[^|;&\n]*\b(commit|push|tag)\b/.test(command) ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen)\b/.test(command) ||
    (/\bgh\s+api\b/.test(command) && /(-X\s*(POST|PATCH|PUT)|\s-[fF]\s|--field|--raw-field|--input)/.test(command));
  if (!writes) return;

  const text = [stripTargetNames(command), ...referencedFiles(command)].join("\n");
  const found = telltales(text);
  if (found.length) {
    deny(`This would put a hint into faultforge-target (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`);
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
    deny(`This edit would put a hint into faultforge-target (${found.join(", ")}). Keep target files free of any mention of the lab.`);
  }
}

/** True when the command runs in, or points at, the target repository. */
function targetsTargetRepo(command: string): boolean {
  return (
    TARGET.test(cwd) ||
    /\b(cd|git\s+-C)\s+["']?[^\s"']*faultforge-target/i.test(command) ||
    /--repo[\s=]+["']?AJBeumer\/faultforge-target\b/i.test(command) ||
    /repos\/AJBeumer\/faultforge-target\//i.test(command) ||
    /github\.com\/AJBeumer\/faultforge-target\b/i.test(command)
  );
}

/** The target's own name and local paths are allowed; mentions of the lab in prose are not. */
function stripTargetNames(text: string): string {
  return text
    .replace(/[^\s"'`]*[/\\][^\s"'`]*/g, (token) => (/faultforge/i.test(token) ? " " : token))
    .replace(/faultforge-target/gi, " ");
}

/** Contents of message or body files the command reads, e.g. `git commit -F msg.txt`. */
function referencedFiles(command: string): string[] {
  const files: string[] = [];
  for (const match of command.matchAll(/(?:\s-F|--file|--body-file|--input)[\s=]+["']?([^\s"']+)/g)) {
    const file = match[1]!;
    if (file === "-") continue;
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
