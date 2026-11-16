/**
 * What the unattended agent is told about the checks it can't run itself, and how the runner reads their
 * result. The agent works on Linux; a commit can pass there and fail on Windows, and a push to a pull request
 * is a review round whether it was green or not. So in a lab ticket's run every commit goes through `ci:wait`
 * first (`review/ci-wait.ts`). A reviewed repository takes writes through the door only, so there the checks
 * run on the pull request, as before.
 */

/**
 * The minutes the agent gives one `ci:wait`: under the ten minutes its Bash tool allows a command, so the
 * command ends itself, says why, and removes its scratch branch. Killed from outside it could do neither.
 */
export const CI_WAIT_MINUTES = 9;

/** The paragraph for the agent's instructions: one for a lab ticket's run, another for a reviewed repository's. */
export function ciWaitInstruction(repoKey: string, labTicket: boolean): string {
  return labTicket
    ? `Before every push to the pull request's branch, the first one too, commit, and then run npm run ci:wait -- ${repoKey} --timeout ${CI_WAIT_MINUTES} as a command of its own (nothing chained or piped before or after it: the policy refuses that, because the run log reads its exit code from its last line), in the foreground, with the Bash tool's longest timeout (600000 ms). It runs the checks on Linux and on Windows for that commit on a scratch branch, which no reviewer reads and which costs no review round. Its last line is ci:wait exit <code>. Push to the pull request only after exit 0. On exit 1, fix what it names and run it again. On exit 2 it could not tell: run it once more, and report stuck if it is 2 again. Run npm run check on its own, never piped into another command: a pipe hides its exit code.`
    : "This repository's checks run on the pull request only: don't run ci:wait here, it refuses. Run npm run check on its own, never piped into another command: a pipe hides its exit code.";
}

/**
 * The exit code `ci:wait` named in its last line, from a tool result's content, or null when it names none
 * (the command was killed, or never ran). Read by the runner for the run log: the code says whether a job
 * failed (1) or the command could not tell (2), which "error" alone does not.
 */
export function ciWaitExitCode(content: unknown, command: string): 0 | 1 | 2 | null {
  if (!CI_WAIT_ALONE.test(command.trim())) return null;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
            .join("\n")
        : "";
  // The marker is the command's last line. Only npm's own report of a failed script may follow it.
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !/^npm (?:error|ERR!)/.test(line));
  const code = /^ci:wait exit ([012])\s*$/.exec(lines.at(-1) ?? "")?.[1];
  return code === undefined ? null : (Number(code) as 0 | 1 | 2);
}

/**
 * A command that runs `ci:wait` and nothing else: no second command, pipe, redirect or substitution, whose
 * output or exit could stand in for its own. Only then is the output's last line the command's own.
 */
const CI_WAIT_ALONE = /^npm run ci:wait(?: -- [\w .:/=-]*?)?(?: 2>&1)?$/;
