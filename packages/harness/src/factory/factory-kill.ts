/**
 * Ending the agent's process tree: when its time limit is hit, when the runner itself is stopped, and when a
 * later tick finds the runner gone but its agent still running.
 */
import { spawnSync } from "node:child_process";

/**
 * Kills a process and its children. A process already gone is no crash; any other failure throws, so a caller
 * never takes a kill that didn't happen for one that did. On Windows `taskkill` answers 128 for a process that
 * isn't there.
 */
export function killTree(
  pid: number,
  kill: (pid: number, signal: string) => void = process.kill,
  taskkill: (pid: number) => { status: number | null; stderr?: string } = (target) =>
    spawnSync("taskkill", ["/PID", String(target), "/T", "/F"], { encoding: "utf8", timeout: 30_000 }),
) {
  if (process.platform === "win32") {
    const result = taskkill(pid);
    if (result.status !== 0 && result.status !== 128)
      throw new Error(`taskkill couldn't end pid ${pid} (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
  } else {
    try {
      kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/** The signals that stop the runner from outside: Ctrl+C, a service stop, a closed terminal. */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
const SIGNAL_NUMBERS: Record<(typeof STOP_SIGNALS)[number], number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
  SIGBREAK: 21,
};

/** The part of `process` this needs, so a test can hand in a fake. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): void;
}

/**
 * While the agent runs, stopping the runner stops the agent too: the time limit is a timer inside the runner, so
 * otherwise the agent would run on with the owner's token and no limit. A kill the runner can't catch (`kill -9`,
 * a power cut) is covered by the lock, whose next holder kills the recorded agent first (`factory-lock.ts`).
 * Returns the function that removes the handlers once the agent has ended on its own.
 */
export function killOnExit(
  pid: number,
  kill: (pid: number) => void = killTree,
  proc: ProcessLike = process,
): () => void {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    try {
      kill(pid);
    } catch {
      // Already gone, or not ours to kill: nothing more this runner can do on its way out.
    }
  };
  const handlers = STOP_SIGNALS.map((signal) => {
    const handler = () => {
      end();
      proc.exit(128 + SIGNAL_NUMBERS[signal]);
    };
    proc.on(signal, handler);
    return [signal, handler] as const;
  });
  proc.on("exit", end);
  return () => {
    done = true;
    for (const [signal, handler] of handlers) proc.off(signal, handler);
    proc.off("exit", end);
  };
}
