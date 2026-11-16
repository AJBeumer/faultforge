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
    ? `Before every push to the pull request's branch, the first one too, commit and run npm run ci:wait -- ${repoKey} --timeout ${CI_WAIT_MINUTES} in the foreground, with the Bash tool's longest timeout (600000 ms). It runs the checks on Linux and on Windows for that commit on a scratch branch, which no reviewer reads and which costs no review round. Its last line is ci:wait exit <code>. Push to the pull request only after exit 0. On exit 1, fix what it names and run it again. On exit 2 it could not tell: run it once more, and report stuck if it is 2 again. Run npm run check on its own, never piped into another command: a pipe hides its exit code.`
    : "This repository's checks run on the pull request only: don't run ci:wait here, it refuses. Run npm run check on its own, never piped into another command: a pipe hides its exit code.";
}

/**
 * The exit code `ci:wait` named in its last line, from a tool result's content, or null when it names none
 * (the command was killed, or never ran). Read by the runner for the run log: the code says whether a job
 * failed (1) or the command could not tell (2), which "error" alone does not.
 */
export function ciWaitExitCode(content: unknown): 0 | 1 | 2 | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
            .join("\n")
        : "";
  const codes = [...text.matchAll(/^ci:wait exit ([012])\s*$/gm)];
  const last = codes.at(-1)?.[1];
  return last === undefined ? null : (Number(last) as 0 | 1 | 2);
}
