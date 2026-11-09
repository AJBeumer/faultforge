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
 * whole command, so a blocked word inside a quoted message also blocks: it fails closed. Text therefore
 * goes through a file (`--body-file`, `git commit -F`), and a denied command says so.
 *
 * Reads the hook payload on stdin. Prints a deny decision as JSON, or nothing to allow.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_RULES: [RegExp, string][] = [
  [/\bgh\s+pr\s+(merge|close|review|comment|ready)\b/i, "only the owner merges, closes or comments on a PR"],
  [/\bgh\s+issue\s+(comment|close|reopen|delete|transfer|lock)\b/i, "the runner reports on the ticket, not the agent"],
  [/\bgh\s+issue\s+edit\b[^\n]*--(add|remove)-label\b/i, "the runner sets the ticket's labels"],
  [
    /\bgh\s+(repo|label|secret|variable|workflow|ruleset|release)\s+(?!view\b|list\b)\w/i,
    "repo settings are the owner's",
  ],
  // The board is a write the runner's audit can't see, so a run may only read it (#113).
  [
    /\bgh\s+project\s+(?!view\b|list\b|field-list\b|item-list\b)\w/i,
    "the runner tracks the ticket; the board is the owner's",
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

/**
 * The run's keys live in its environment. These rules make reading them, or sending anything out,
 * a deliberate act the hook sees. Like every text rule they are a seatbelt, not a wall: the runner's
 * after-run audit and a narrow token are the other layers.
 */
const SECRET_RULES: [RegExp, string][] = [
  [
    /\b(GH_TOKEN|GITHUB_TOKEN|QODO_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|FACTORY_GH_TOKEN)\b/,
    "the run's keys are off limits",
  ],
  [/(^|[\s;&|(])(env|printenv|set|export\s+-p|declare\s+-x)(\s*($|[;&|>)]))/m, "no dumping the environment"],
  [/\/proc\/[^\s/]+\/environ|\bGet-ChildItem\s+env:|\$env:/i, "no reading the environment"],
  [/\bgh\s+auth\s+(token|status\s+(-t|--show-token))/i, "no printing the GitHub token"],
];

/** Hosts a run may reach with its own HTTP tools: only the app it starts for a live check. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Reasons a shell command is not allowed in a factory run, or an empty list. `ticket` is the run's ticket
 * number: the agent must read the ticket from the runner's checked snapshot, never live from GitHub,
 * where someone could have added text after the check.
 */
export function commandViolations(raw: string, ticket?: string): string[] {
  // One logical line per command: a backslash (bash) or backtick (PowerShell) line continuation can't
  // split a command into pieces that no rule sees whole.
  const command = raw.replace(/[\\`]\r?\n/g, " ");
  const reasons = [...COMMAND_RULES, ...SECRET_RULES]
    .filter(([pattern]) => pattern.test(command))
    .map(([, reason]) => reason);
  if (/\b(curl|wget|nc|ncat|netcat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(command)) {
    const hosts = [...command.matchAll(/\b(?:https?|ftp):\/\/([^/\s:'"]+|\[[^\]]+\])/gi)].map((m) =>
      (m[1] ?? "").toLowerCase(),
    );
    if (!hosts.length || hosts.some((h) => !LOCAL_HOSTS.has(h))) {
      reasons.push("HTTP tools may only reach the app on localhost; GitHub goes through gh");
    }
  }
  if (ticket && /^\d+$/.test(ticket)) {
    const live = [
      // Any issue view, list or status, whatever the number is written as ($VAR, "$N", #18, a URL).
      /\bgh\s+issue\s+(view|list|status)\b/,
      // Search can return issue bodies.
      /\bgh\s+search\b/,
      // GraphQL can read any issue.
      /\bgh\b[\s\S]*\bgraphql\b/i,
    ];
    // Any gh api call in a command that mentions issues or search anywhere, in any order (a path can be
    // built in a variable first). Deliberately broad: after three rounds of new spellings, a rule that
    // lists endpoints can't be complete. The agent doesn't need these: review:wait saves Qodo's comments.
    const apiOnIssues = /\bgh\b[\s\S]*\bapi\b/i.test(command) && /\b(issues|search)\b/i.test(command);
    if (apiOnIssues || live.some((pattern) => pattern.test(command))) {
      reasons.push("read the ticket from the runner's snapshot file, not live from GitHub");
    }
  }
  return reasons;
}

/**
 * Where a path really lands on disk: the nearest existing folder is resolved through symlinks and
 * junctions, and the rest is appended. A link inside the run can't smuggle an edit outside it.
 */
export function realTarget(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}

/** True when `path` is inside `folder` (or is it). */
function inside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return (
    rel === "" || (!rel.startsWith("..") && !/^[a-z]:/i.test(rel) && !rel.startsWith("/") && !rel.startsWith("\\"))
  );
}

/**
 * Why a file edit is not allowed, or undefined. Only the run's own folder and the temp folder may change,
 * and never a `.claude` folder (it holds the agent's own guardrails) or `.github/workflows` (the factory's
 * own controls, and the run's token has no Workflows permission, so a push would fail anyway; #103).
 */
export function editViolation(path: string, runRoot: string | undefined, temp = tmpdir()): string | undefined {
  if (!runRoot) return "the run has no FAULTFORGE_RUN_ROOT, so no file may change";
  const real = realTarget(path);
  if ([resolve(path), real].some((p) => /(^|[/\\])\.claude([/\\]|$)/i.test(p))) {
    return "the agent can't change its own guardrails (.claude)";
  }
  if ([resolve(path), real].some((p) => /(^|[/\\])\.github[/\\]workflows([/\\]|$)/i.test(p))) {
    return "the agent can't change the workflows (.github/workflows): the owner does, with a token that may";
  }
  if (inside(real, realTarget(runRoot)) || inside(real, realTarget(temp))) return undefined;
  return `only files under the run's folder may change, not ${path}`;
}

/**
 * Patterns read the whole command, so a message that only quotes a blocked word is blocked too (#73).
 * Telling a quote from a real call would need a shell parser, and simpler tests reopen bypasses, so
 * the rules stay broad. This is the way around that keeps them closed: text goes through a file.
 */
export const TEXT_AS_FILE_HINT =
  "If the block came only from words inside a message, write the text with the Write tool to a file in the run's folder or the temp folder and pass the file: gh pr create/edit --body-file, git commit -F";

/** The reason shown to the agent for a denied tool call. */
export function denialReason(tool: string, reasons: string[]): string {
  const hint = tool === "Bash" || tool === "PowerShell" ? ` ${TEXT_AS_FILE_HINT}.` : "";
  return `Not allowed in an unattended factory run: ${reasons.join("; ")}.${hint} If the ticket needs this, stop and report it as stuck.`;
}

/**
 * Fails closed. Claude Code treats a hook that crashes (exit 1, a stack trace) as a non-blocking error
 * and runs the tool anyway, so an exception here (unreadable input, a path that can't be resolved) would
 * be a bypass. Inside a run, any error becomes a blocking error instead: exit 2 with a one-line reason
 * on stderr, which Claude Code shows to the agent and acts on by refusing the tool call.
 */
function main() {
  if (!process.env.FAULTFORGE_FACTORY_RUN) return;
  let tool = "";
  let reasons: string[] = [];
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    tool = String(input.tool_name ?? "");
    const args = input.tool_input ?? {};
    const cwd: string = input.cwd ?? process.cwd();
    if (tool === "Bash" || tool === "PowerShell")
      reasons = commandViolations(String(args.command ?? ""), process.env.FAULTFORGE_TICKET_NUMBER);
    else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const reason = editViolation(
        resolve(cwd, String(args.file_path ?? args.notebook_path ?? "")),
        process.env.FAULTFORGE_RUN_ROOT,
      );
      if (reason) reasons = [reason];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(
      `factory-policy hook failed: ${message}. Not allowed in an unattended factory run: a hook that can't check lets nothing through. If the ticket needs this, stop and report it as stuck.`,
    );
    process.exit(2);
  }
  if (!reasons.length) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denialReason(tool, reasons),
      },
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
