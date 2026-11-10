/**
 * What the two PreToolUse hooks share: the shape of a decision, how a hook reads its payload, how it
 * answers Claude Code, and how it tells that it is the file being run rather than a module under test.
 *
 * A hook's decision function returns one of these and never prints or exits, so a test can call it
 * in-process. Only `main()` in each hook, run as `node <file>`, turns the decision into output.
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  /** The hook couldn't check, so the tool call is refused: exit 2 with one line on stderr. */
  | { kind: "error"; message: string };

export const ALLOW: Decision = { kind: "allow" };

/** The whole payload Claude Code writes to the hook's stdin. */
export function readStdin(): string {
  return readFileSync(0, "utf8");
}

/** The first line of an error's message, for a one-line reason. */
export function firstLine(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
}

/**
 * Answers Claude Code as a PreToolUse hook must. A deny is a JSON decision on stdout and exit 0; Claude
 * Code shows the reason to the agent and refuses the tool call. A blocking error is one line on stderr
 * and exit 2, which Claude Code also treats as a refusal (a crash with exit 1 would be a non-blocking
 * error, and the tool would run). An allow prints nothing.
 */
export function respond(decision: Decision): void {
  if (decision.kind === "allow") return;
  if (decision.kind === "error") {
    console.error(decision.message);
    process.exit(2);
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }),
  );
}

/**
 * True when the module at `moduleUrl` is the file node was started with (`node <file>`), not a module a
 * test imported. Both paths are resolved through the file system first, so a drive letter or folder spelled
 * in another case, or a junction on the way, can't make a hook mistake itself for an import and stay
 * silent: for a guard, silence is a bypass. If a path can't be resolved, the spellings are compared as given.
 */
export function isEntry(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  const module = fileURLToPath(moduleUrl);
  try {
    return realpathSync.native(entry) === realpathSync.native(module);
  } catch {
    return resolve(entry) === module;
  }
}
