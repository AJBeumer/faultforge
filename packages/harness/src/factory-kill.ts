/**
 * Ending the agent's process tree: when its time limit is hit, when the runner itself is stopped, and when a
 * later tick finds the runner gone but its agent still running (AUD-M19). Split from factory-agent.ts.
 */
import { spawnSync } from "node:child_process";

/** Kills a process and its children. A process already gone is no crash (audit N-12). */
export function killTree(pid: number, kill: (pid: number, signal: string) => void = process.kill) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else {
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
 * While the agent runs, stopping the runner stops the agent too. Without this, killing the runner left the
 * agent running with the owner's token and no time limit, since the limit is a timer inside the runner
 * (AUD-M19). On a stop signal the agent's tree is killed and the runner exits as that signal would have
 * made it; on a normal exit of the runner the tree is killed as well. A kill the runner can't catch
 * (`kill -9`, a power cut) is covered by the lock instead: it records the agent's pid, and the next tick
 * that takes the lock over kills that tree first (`factory-lock.ts`). Returns the function that removes the
 * handlers once the agent has ended on its own.
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
