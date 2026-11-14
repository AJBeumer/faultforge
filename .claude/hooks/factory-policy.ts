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
 *  - naming a key, reading the whole environment (`env`, `printenv`, `process.env`, `os.environ`, `%ENV`,
 *    `ENV`, a name built at run time), and requests to anything but the app on localhost, by a tool (`curl`,
 *    `ssh`) or by code (`fetch(`, `http.request`)
 *  - aliases (`gh alias set`, `git config alias.*`), the private repo by name or by numeric repository id
 *  - shell writes to the guardrails (`.claude/`, `neutral.ts`), and running a script this run wrote (#284)
 *  - reading `/proc`, the answer key, the audit log and the templates with any tool, and in a target ticket's
 *    run the private checkouts the runner names in `FAULTFORGE_PRIVATE_CHECKOUTS` (#284)
 *
 * Every rule reads the command as written and in normalised spellings (shell-decode.ts): `g''h`, `\gh`,
 * `${x}`, ANSI-C strings, and a program's punctuation read as spaces.
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
import { commandViolations, readings } from "./factory-policy-commands.ts";
import {
  guardrailWriteViolation,
  privateCommandViolation,
  readViolation,
  scriptViolation,
} from "./factory-policy-paths.ts";
import { ALLOW, type Decision, firstLine, hookAnswer, isEntry, readStdin, respond } from "./hook-io.ts";
import { MAX_COMMAND_CHARS } from "./shell-scan.ts";

/** The tools that only read files; Claude Code's settings route them to this hook too (#284). */
const READ_TOOLS = ["Read", "Grep", "Glob", "NotebookRead"];

export { commandViolations } from "./factory-policy-commands.ts";

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
  // The giveaway word list both hooks read: emptied, it would let every hint through (AUD-M4, re-grade).
  if ([resolve(path), real].some((p) => /(^|[/\\])packages[/\\]harness[/\\]src[/\\]neutral\.ts$/i.test(p))) {
    return "the agent can't change the giveaway word list (neutral.ts) the guard hooks read";
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
      // Only a command short enough to read is looked at further; the length rule above already refuses it.
      if (command.length <= MAX_COMMAND_CHARS) {
        for (const reason of [
          guardrailWriteViolation(command, cwd),
          privateCommandViolation(command, env),
          scriptViolation(command, cwd, env),
        ])
          if (reason && !reasons.includes(reason)) reasons.push(reason);
      }
    } else if (READ_TOOLS.includes(tool)) {
      const reason = readViolation(args, cwd, env);
      if (reason) reasons = [reason];
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
