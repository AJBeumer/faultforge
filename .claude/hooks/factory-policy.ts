/**
 * Claude Code PreToolUse hook for unattended factory runs. Does nothing unless `FAULTFORGE_FACTORY_RUN`
 * is set, which `npm run factory:tick` does for the agent it starts. Inside a run it blocks what only
 * the owner may do:
 *  - merging, closing, approving or commenting on a PR (so no reply to a review finding)
 *  - commenting on, closing or relabelling a ticket (the runner reports on the ticket, not the agent)
 *  - API writes through `gh api`, and repo, label, secret, variable and workflow changes
 *  - force pushes, deleting remote branches, and pushing to `main` or `master`
 *  - scheduled tasks and persistent environment or registry changes
 *  - dismissing anything
 *  - file edits outside the run's own folder (`FAULTFORGE_RUN_ROOT`) and the temp folder
 *
 * It runs next to the guard hook, which still keeps the reviewed repos free of hints. Patterns read the
 * whole command, so a blocked word inside a quoted message also blocks: it fails closed.
 *
 * Reads the hook payload on stdin. Prints a deny decision as JSON, or nothing to allow.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_RULES: [RegExp, string][] = [
  [/\bgh\s+pr\s+(merge|close|review|comment|ready)\b/i, "only the owner merges, closes or comments on a PR"],
  [/\bgh\s+issue\s+(comment|close|reopen|delete|transfer|lock)\b/i, "the runner reports on the ticket, not the agent"],
  [/\bgh\s+issue\s+edit\b[^\n]*--(add|remove)-label\b/i, "the runner sets the ticket's labels"],
  [
    /\bgh\s+(repo|label|secret|variable|workflow|ruleset|release)\s+(?!view\b|list\b)\w/i,
    "repo settings are the owner's",
  ],
  [
    /\bgh\s+api\b[^\n]*(\s(-X|--method)[\s=]*(?!GET\b)\w|\s(-f|-F|--field|--raw-field|--input)[\s=])/i,
    "gh api is read-only here",
  ],
  [
    /\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*(\s(-f|--force|--force-with-lease|--force-if-includes|--mirror|--delete|-d|--prune)\b|\s\+\S|\s:\S)/i,
    "no force push or remote delete",
  ],
  [/\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*\s(\S+:)?(refs\/heads\/)?(main|master)(\s|$)/i, "never push to main"],
  [/\b(schtasks|setx|crontab|launchctl|reg\s+(add|delete|import))\b/i, "no scheduled tasks or persistent settings"],
  [/\bdismiss/i, "never dismiss a finding"],
];

/** Reasons a shell command is not allowed in a factory run, or an empty list. */
export function commandViolations(command: string): string[] {
  return COMMAND_RULES.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
}

/** True when `path` is inside `folder` (or is it). */
function inside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return (
    rel === "" || (!rel.startsWith("..") && !/^[a-z]:/i.test(rel) && !rel.startsWith("/") && !rel.startsWith("\\"))
  );
}

/** Why a file edit is not allowed, or undefined. Only the run's own folder and the temp folder may change. */
export function editViolation(path: string, runRoot: string | undefined, temp = tmpdir()): string | undefined {
  if (!runRoot) return "the run has no FAULTFORGE_RUN_ROOT, so no file may change";
  if (inside(path, runRoot) || inside(path, temp)) return undefined;
  return `only files under the run's folder may change, not ${path}`;
}

function main() {
  if (!process.env.FAULTFORGE_FACTORY_RUN) return;
  const input = JSON.parse(readFileSync(0, "utf8"));
  const tool: string = input.tool_name ?? "";
  const args = input.tool_input ?? {};
  const cwd: string = input.cwd ?? process.cwd();
  let reasons: string[] = [];
  if (tool === "Bash" || tool === "PowerShell") reasons = commandViolations(String(args.command ?? ""));
  else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const reason = editViolation(
      resolve(cwd, String(args.file_path ?? args.notebook_path ?? "")),
      process.env.FAULTFORGE_RUN_ROOT,
    );
    if (reason) reasons = [reason];
  }
  if (!reasons.length) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Not allowed in an unattended factory run: ${reasons.join("; ")}. If the ticket needs this, stop and report it as stuck.`,
      },
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
