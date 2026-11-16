/**
 * What the unattended agent is told about the checks it can't run itself. It works on Linux; a commit can
 * pass there and fail on Windows, and a push to a pull request is a review round whether it was green or
 * not. So in a lab ticket's run every commit goes through `ci:wait` first (`review/ci-wait.ts`). A reviewed
 * repository takes writes through the door only, so there the checks run on the pull request, as before.
 */

/** The paragraph for the agent's instructions: one for a lab ticket's run, another for a reviewed repository's. */
export function ciWaitInstruction(repoKey: string, labTicket: boolean): string {
  return labTicket
    ? `Before every push to the pull request's branch, the first one too, commit and run npm run ci:wait -- ${repoKey} (foreground, the Bash tool's longest timeout). It runs the checks on Linux and on Windows for that commit on a scratch branch, which no reviewer reads and which costs no review round. Push to the pull request only after it exits 0. While it exits 1, fix what it names and run it again; if it exits 2 twice, report stuck. Run npm run check on its own, never piped into another command: a pipe hides its exit code.`
    : "This repository's checks run on the pull request only: don't run ci:wait here, it refuses. Run npm run check on its own, never piped into another command: a pipe hides its exit code.";
}
