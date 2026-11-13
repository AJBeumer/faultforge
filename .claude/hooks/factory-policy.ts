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
 *  - edits in the private worktree to the answer key, the audit log, `templates/` or `config/` (#142)
 *  - `review:wait` started in the background: a headless run ends with the agent's turn (#129)
 *
 * It runs next to the guard hook, which still keeps the reviewed repos free of hints. Patterns read the
 * whole command, so a blocked word inside a quoted message also blocks: it fails closed. Text therefore
 * goes through a file (`--body-file`, `git commit -F`), and a denied command says so.
 *
 * `decide()` takes the hook payload as text and returns the decision without printing or exiting, so the
 * tests call it in-process. Run as `node <this file>`, `main()` reads the payload from stdin and answers:
 * a deny decision as JSON, nothing to allow, or exit 2 with one line on stderr when it couldn't check.
 */
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ALLOW, type Decision, firstLine, hookAnswer, isEntry, readStdin, respond } from "./hook-io.ts";

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
  // The branch may be quoted, and may end the step with a shell operator right after it (#194).
  [
    /\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*\s([^\s:]*:)?["']?(refs\/heads\/)?(main|master)["']?(?=[\s;&|)]|$)/i,
    "never push to main",
  ],
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
  [
    /(^|[\s;&|(])(env|printenv|set|export\s+-p|declare\s+-x)(\s*($|[;&|>)]))/m,
    'no dumping the environment (one variable by name, such as echo "$FAULTFORGE_TICKET_FILE", is fine)',
  ],
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
  const reasons: string[] = [];
  for (const command of readings(raw)) {
    for (const reason of violationsIn(command, ticket)) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/** The reasons found in one reading of the command. */
function violationsIn(command: string, ticket?: string): string[] {
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
 * The ways a shell reads a backslash or backtick before a newline. Bash removes a backslash-newline pair
 * outright, so a name split across lines (`review:\` newline `wait`) runs as one word. PowerShell reads a
 * backtick-newline as a separator. And in Bash a backtick before a newline opens a command substitution, so
 * the words around it stay apart (Qodo on PR 132: `true` backtick newline `git push --force …` backtick runs
 * the push). No rule can know which shell will run the text, so every rule reads the command both ways,
 * glued and spaced, and a violation in either reading counts: the rules fail closed.
 */
function readings(raw: string): string[] {
  const continuation = /[\\`]\r?\n/g;
  return [...new Set([raw.replace(continuation, ""), raw.replace(continuation, " ")])];
}

/**
 * A shell's own ways of putting a command in the background: a single `&` (not `&&`, not a `>&` or `|&`
 * redirect), `nohup`, `setsid`, `disown`, PowerShell's `Start-Job` and `Start-Process`, cmd's `start /b`.
 */
const SHELL_BACKGROUND = /(?<![&>|])&(?!&)|\b(nohup|setsid|disown|Start-Job|Start-Process)\b|\bstart\s+\/b\b/i;

/** True when the command runs the review wait, by its npm script or by its file. */
const RUNS_REVIEW_WAIT = /\breview[:-]wait\b/i;

/**
 * Why a command may not run in the background, or undefined. The review wait must run in the foreground: a
 * headless run ends with the agent's turn, so a background task is killed before it saves the review, and
 * nobody wakes the agent (run 20261110-150249, #129). `background` is the Bash tool's own flag; the shell's
 * ways of backgrounding count the same (Qodo on PR 132). Starting the app in the background for a live check
 * stays allowed.
 */
export function backgroundViolation(raw: string, background: boolean): string | undefined {
  const read = readings(raw);
  if (!read.some((command) => RUNS_REVIEW_WAIT.test(command))) return undefined;
  if (!background && !read.some((command) => SHELL_BACKGROUND.test(command))) return undefined;
  return "run review:wait in the foreground (timeout 600000, --timeout 9, again while it exits 1): a background task dies with your turn, and in a run that is the end of the run";
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
 * What an unattended run may never edit in the private repository's worktree (#142): the answer key and
 * the audit log are append-only and the owner's to amend, the templates hold unreviewed cases, and
 * `config/` holds Qodo's configuration snapshots. Evidence (`raw-artifacts/`, `factory-log/`) is fine.
 */
const PRIVATE_PROTECTED = ["ground-truth.jsonl", "audit-events.jsonl", "templates", "config"];

/**
 * Why an edit in the private worktree is not allowed, or undefined. The runner checks the private
 * worktree out at `<run root>/<lab checkout>/private` (and the owner's own copy sits at the same place
 * under their checkout), so a path whose second segment below the run root is `private` is in it. The
 * post-run diff check in `saveEvidence` is the guarantee; this is the first line, so the agent learns
 * at the edit, not at the end of the run, that the file isn't its to change.
 */
export function privateViolation(path: string, runRoot: string): string | undefined {
  const rel = relative(realTarget(runRoot), path);
  if (rel === "" || rel.startsWith("..") || /^[a-z]:/i.test(rel) || /^[/\\]/.test(rel)) return undefined;
  const [, folder, entry] = rel.split(/[/\\]/);
  if (folder !== "private" || !entry) return undefined;
  const hit = PRIVATE_PROTECTED.find((name) => name.toLowerCase() === entry.toLowerCase());
  if (!hit) return undefined;
  return `the agent can't change ${hit} in the private repository (the answer key, the audit log, templates/ and config/ are the owner's)`;
}

/**
 * Why a file edit is not allowed, or undefined. Only the run's own folder and the temp folder may change,
 * and never a `.claude` folder (it holds the agent's own guardrails), `.github/workflows` (the factory's
 * own controls, and the run's token has no Workflows permission, so a push would fail anyway; #103), or
 * the private repository's protected files (#142).
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
  for (const p of [resolve(path), real]) {
    const reason = privateViolation(p, runRoot);
    if (reason) return reason;
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
 * The decision for one hook payload, given the run's environment (`FAULTFORGE_FACTORY_RUN`,
 * `FAULTFORGE_RUN_ROOT`, `FAULTFORGE_TICKET_NUMBER`). Outside a run everything is allowed, whatever the
 * payload says: there is nothing to protect. Inside a run it fails closed: an exception (unreadable input, a
 * path that can't be resolved) is a blocking error, never an allow, because Claude Code treats a hook that
 * crashes as a non-blocking error and runs the tool anyway.
 */
export function decide(stdin: string, env: NodeJS.ProcessEnv = process.env): Decision {
  if (!env.FAULTFORGE_FACTORY_RUN) return ALLOW;
  let tool = "";
  let reasons: string[] = [];
  try {
    const input = JSON.parse(stdin);
    tool = String(input.tool_name ?? "");
    const args = input.tool_input ?? {};
    const cwd: string = input.cwd ?? process.cwd();
    if (tool === "Bash" || tool === "PowerShell") {
      const command = String(args.command ?? "");
      reasons = commandViolations(command, env.FAULTFORGE_TICKET_NUMBER);
      const background = backgroundViolation(command, args.run_in_background === true);
      if (background) reasons.push(background);
    } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const reason = editViolation(
        resolve(cwd, String(args.file_path ?? args.notebook_path ?? "")),
        env.FAULTFORGE_RUN_ROOT,
      );
      if (reason) reasons = [reason];
    }
  } catch (error) {
    return failed(error);
  }
  if (!reasons.length) return ALLOW;
  return { kind: "deny", reason: denialReason(tool, reasons) };
}

/** The hook's own failure, inside a run, as a blocking error: the tool call is refused, never let through. */
function failed(error: unknown): Decision {
  return {
    kind: "error",
    message: `factory-policy hook failed: ${firstLine(error)}. Not allowed in an unattended factory run: a hook that can't check lets nothing through. If the ticket needs this, stop and report it as stuck.`,
  };
}

function main() {
  // Outside a run there is nothing to protect, whatever stdin holds or whether it can be read at all.
  if (!process.env.FAULTFORGE_FACTORY_RUN) return;
  respond(hookAnswer(readStdin, decide, failed));
}

if (isEntry(import.meta.url)) main();
