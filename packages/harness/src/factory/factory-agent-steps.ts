/**
 * The names the run log gives an agent's shell commands: which steps of the factory loop a command holds. Read by
 * the launcher (`factory-agent.ts`) as the agent works, and by the timeline (`factory-timeline.ts`) afterwards.
 */
import { CI_WAIT_ALONE } from "./factory-agent-checks.ts";

/**
 * The steps worth showing on the timeline: what marks each in a command, and its name, in the order they are
 * named. Mark first: the door's test reads a quoted step name followed by a comma as a git call in code.
 */
const STEPS: [RegExp, string][] = [
  [/\bgh\s+pr\s+create\b|\btarget:post\s+--\s+pr-create\b/, "pr-opened"],
  [/\breview:wait\b/, "review-wait"],
  [/\bci:wait\b/, "ci-wait"],
  [/\bgit\b[^\n]*\bpush\b|\btarget:post\s+--\s+push\b/, "push"],
  [/\bnpm\s+run\s+check\b/, "check"],
  [/\bticket:ready\b/, "ticket-ready"],
  [/\brevert:check\b/, "revert-check"],
];

/**
 * A short name for an agent's shell command worth showing on the timeline, or null. A command that holds several
 * steps names each, joined by "+" (`ci-wait+push`), so none is missing from the log; `stepHas` reads one part.
 * Only a wait that is the whole command is plain "ci-wait": then the command's exit code is the wait's own. A wait
 * joined to anything that is no step of its own is "ci-wait+more".
 */
export function agentStep(command: string): string | null {
  const names = STEPS.filter(([mark]) => mark.test(command)).map(([, name]) => name);
  if (names.join() === "ci-wait" && !CI_WAIT_ALONE.test(command)) return "ci-wait+more";
  return names.length ? names.join("+") : null;
}

/** True when the step name `step` (from `agentStep`) holds `part`. */
export function stepHas(step: unknown, part: string): boolean {
  return typeof step === "string" && step.split("+").includes(part);
}
