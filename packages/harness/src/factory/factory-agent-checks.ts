/**
 * What the unattended agent is told about the checks it can't run itself. The agent works on Linux; a commit
 * can pass there and fail on Windows, and a push to a pull request is a review round whether it was green or
 * not. So in a lab ticket's run every commit goes through `ci:wait` first (`review/ci-wait.ts`). A reviewed
 * repository takes writes through the door only, so there the checks run on the pull request, as before.
 *
 * The run log records each `ci:wait` as a step, with the exit code of the command that ran it, as the agent's
 * Bash tool reported it (`toolExitCode`). It reads nothing the command printed: that text is the agent's own.
 */

/**
 * A command that is `ci:wait` and nothing else: no other step before or after it, no pipe, no redirect but its
 * errors to its output. Only then is the command's exit code the wait's own.
 */
export const CI_WAIT_ALONE = /^\s*npm run ci:wait(?: -- [\w .:=-]*)?(?: 2>&1)?\s*$/;

/**
 * The run log's entry for a step's result: whether it failed, and for a `ci-wait` step (the wait was the whole
 * command) its exit code too. A wait joined to other steps has none: their code would be the whole command's.
 */
export function stepResult(
  step: string | undefined,
  content: unknown,
  isError: boolean,
): { step: string | undefined; error: boolean; exitCode?: number | null } {
  return step === "ci-wait"
    ? { step, error: isError, exitCode: toolExitCode(content, isError) }
    : { step, error: isError };
}

/**
 * The exit code of a Bash command, as the agent's tool reported it, or null when the tool named none (the
 * command was refused, timed out or was killed). A result that is no error is exit 0. A failed one starts with
 * the tool's own first line, `Exit code <n>`, written before anything the command printed; a command can't
 * put a line above it. When the command joined several steps, this is the code of the whole command.
 */
export function toolExitCode(content: unknown, isError: boolean): number | null {
  if (!isError) return 0;
  const first = Array.isArray(content) ? content[0] : content;
  const text =
    typeof first === "string"
      ? first
      : first && typeof first === "object" && (first as { type?: unknown }).type === "text"
        ? String((first as { text?: unknown }).text ?? "")
        : "";
  const code = /^Exit code (\d{1,3})(?:\r?\n|$)/.exec(text)?.[1];
  return code === undefined ? null : Number(code);
}

/**
 * The minutes the agent gives one `ci:wait`: under the ten minutes its Bash tool allows a command, so the
 * command ends itself, says why, and removes its scratch branch. Killed from outside it could do neither.
 */
export const CI_WAIT_MINUTES = 9;

/** The paragraph for the agent's instructions: one for a lab ticket's run, another for a reviewed repository's. */
export function ciWaitInstruction(repoKey: string, labTicket: boolean): string {
  return labTicket
    ? `Before every push to the pull request's branch, the first one too, commit, and then run npm run ci:wait -- ${repoKey} --timeout ${CI_WAIT_MINUTES}, in the foreground, with the Bash tool's longest timeout (600000 ms). It runs the checks on Linux and on Windows for that commit on a scratch branch, which no reviewer reads and which costs no review round. Its last line is ci:wait exit <code>. Push to the pull request only after exit 0. On exit 1, fix what it names and run it again. On exit 2 it could not tell: run it once more, and report stuck if it is 2 again. Run npm run check on its own, never piped into another command: a pipe hides its exit code.`
    : "This repository's checks run on the pull request only: don't run ci:wait here, it refuses. Run npm run check on its own, never piped into another command: a pipe hides its exit code.";
}
