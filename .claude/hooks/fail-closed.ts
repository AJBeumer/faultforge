/**
 * The entry point Claude Code runs for each guard hook (AUD-M4):
 *
 *   node fail-closed.ts <hook file> [arguments]
 *
 * It runs the hook as a child process with the same stdin and passes on its answer only when that answer
 * is clean: exit 0 with nothing on stdout (allow) or with a JSON decision, or exit 2 (refused). Anything
 * else is refused with exit 2: a hook that can't load (a syntax error, an import that fails or throws), a
 * crash (exit 1), a signal, a malformed answer, or a hook that runs past `BUDGET_MS`. Claude Code treats
 * exit 1 and a timed-out hook as non-blocking and runs the tool unchecked, so without this wrapper every
 * one of those failures was an allow.
 *
 * It imports nothing from the project, only node's own modules, so a broken project file can't break it.
 * A relative hook file is resolved from this folder.
 *
 * Exit codes: 0 the hook answered cleanly with exit 0 (its stdout is passed on); 2 refused: the hook refused,
 * or it failed, timed out or answered in a way Claude Code can't read.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long the hook may take: inside the 15 s Claude Code gives the hook in settings.json, with room to spare. */
export const BUDGET_MS = 12_000;

/** What the child hook did. */
export interface Outcome {
  status: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** The wrapper's own answer for one outcome: the exit code and what to write to stdout and stderr. */
export function answer(name: string, outcome: Outcome): { code: 0 | 2; stdout: string; stderr: string } {
  const why = (detail: string) => ({
    code: 2 as const,
    stdout: "",
    stderr: `${name} failed (${detail}). The action is refused: a guard that can't check lets nothing through. Fix the hook; don't work around it.`,
  });
  const firstLine = (outcome.stderr.trim().split("\n")[0] ?? "").slice(0, 300);
  if (outcome.error) {
    const timedOut = /ETIMEDOUT/.test(String((outcome.error as NodeJS.ErrnoException).code ?? outcome.error.message));
    return why(timedOut ? `no answer within ${BUDGET_MS} ms` : outcome.error.message);
  }
  if (outcome.signal) return why(`stopped by ${outcome.signal}`);
  if (outcome.status === 2) {
    return { code: 2, stdout: "", stderr: firstLine || `${name} refused the action without a reason.` };
  }
  if (outcome.status !== 0) return why(`exit ${outcome.status}${firstLine ? `: ${firstLine}` : ""}`);
  const out = outcome.stdout.trim();
  if (!out) return { code: 0, stdout: "", stderr: "" };
  try {
    const decision = JSON.parse(out).hookSpecificOutput;
    // Only a decision Claude Code acts on passes: any other event name or decision is ignored by Claude
    // Code, which then runs the tool, so it is refused here (Qodo on PR 265).
    const valid =
      decision?.hookEventName === "PreToolUse" && ["allow", "deny", "ask"].includes(decision?.permissionDecision);
    if (valid) return { code: 0, stdout: out, stderr: "" };
  } catch {
    // not JSON
  }
  return why("its answer is not a hook decision");
}

/** Runs the hook named on the command line with this process's stdin, and answers for it. */
export function run(argv: string[], stdin: () => Buffer, timeout = BUDGET_MS): ReturnType<typeof answer> {
  const [hook, ...rest] = argv;
  if (!hook) return answer("fail-closed.ts", { status: 1, stdout: "", stderr: "no hook file named" });
  const file = isAbsolute(hook) ? hook : resolve(import.meta.dirname, hook);
  let input: Buffer;
  try {
    input = stdin();
  } catch (error) {
    return answer(hook, { status: 1, stdout: "", stderr: `couldn't read stdin: ${(error as Error).message}` });
  }
  const result = spawnSync(process.execPath, [file, ...rest], {
    input,
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return answer(hook.replace(/^.*[/\\]/, ""), {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  });
}

/** True when node was started with this file, not a test importing it. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  let result: ReturnType<typeof answer>;
  try {
    result = run(process.argv.slice(2), () => readFileSync(0));
  } catch (error) {
    result = answer("fail-closed.ts", { status: 1, stdout: "", stderr: (error as Error).message });
  }
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.code;
}
