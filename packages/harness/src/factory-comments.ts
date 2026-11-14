/**
 * The marks the runner puts in its own ticket comments. The runner posts with the owner's token, so GitHub
 * shows them as the owner's; the marks are how the runner tells its own comments apart from what the owner
 * wrote. Plain HTML comments: they don't show on the page and give nothing away on a reviewed repo.
 */
import type { RunMode } from "./factory-workspace.ts";

/** Starts every comment the runner posts on a ticket. */
export const RUNNER_MARKER = "<!-- scheduled-run -->";

/** `body` as the runner posts it: its mark on a line of its own first. */
export function runnerComment(body: string): string {
  return body.startsWith(RUNNER_MARKER) ? body : `${RUNNER_MARKER}\n${body}`;
}

/** True when a comment was posted by the runner (it starts with the runner's mark). */
export function isRunnerComment(body: string | null | undefined): boolean {
  return (body ?? "").trimStart().startsWith(RUNNER_MARKER);
}

/** Ends the claim comment: which way of running the factory (Actions or the owner's PC) claimed the ticket. */
export function claimMarker(mode: RunMode): string {
  return `<!-- scheduled-run claim mode=${mode} -->`;
}

/** The mode of the latest claim among `bodies` (oldest first), or null when none carries a claim mark. */
export function claimModeOf(bodies: string[]): RunMode | null {
  for (const body of [...bodies].reverse()) {
    const match = body.match(/<!-- scheduled-run claim mode=(ci|local) -->/);
    if (match) return match[1] as RunMode;
  }
  return null;
}
