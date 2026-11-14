/**
 * Telling one process from another that later got the same pid: a pid alone names a process only while it
 * runs, and after a crash or a restart the system hands it on. A process is the one recorded when its pid is
 * alive and it started when the record says (AUD-M19, Qodo on PR 262). Used for the lock's holder.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** When this process started, in epoch milliseconds. */
export function ownStartMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/** Linux: from `/proc`, the process's start in clock ticks after the machine's boot. */
function linuxStartMs(pid: number): number | null {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The second field (the program name, in brackets) can hold spaces; the rest follow its closing bracket.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
  const hz = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 15_000 }).stdout) || 100;
  return Number.isFinite(ticks) && Number.isFinite(boot) ? Math.round(boot * 1000 + (ticks / hz) * 1000) : null;
}

/** Windows: from PowerShell, the process's start time. */
function windowsStartMs(pid: number): number | null {
  const out = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
    { encoding: "utf8", timeout: 30_000 },
  );
  const at = Date.parse((out.stdout ?? "").trim());
  return out.status === 0 && Number.isFinite(at) ? at : null;
}

/** Elsewhere: `ps`, to the second. */
function psStartMs(pid: number): number | null {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 15_000 });
  const at = Date.parse((out.stdout ?? "").trim());
  return out.status === 0 && Number.isFinite(at) ? at : null;
}

/** When the process with `pid` started, in epoch milliseconds, or null when that can't be read. */
export function processStartMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") return linuxStartMs(pid);
    if (process.platform === "win32") return windowsStartMs(pid);
    return psStartMs(pid);
  } catch {
    return null;
  }
}

/** How far two readings of one process's start may differ: clock ticks, rounding, `ps`'s whole seconds. */
export const START_TOLERANCE_MS = 5000;

/**
 * True when the live process `pid` is the one that started at `started`. Anything that can't be read
 * (no start recorded, as in a lock written before this rule, or a start the system won't give) counts as
 * the same process: a process is only taken for another on evidence, never on a failed look.
 */
export function sameProcess(
  pid: number,
  started: number | undefined,
  read: (pid: number) => number | null = processStartMs,
): boolean {
  if (started === undefined || !Number.isFinite(started)) return true;
  const actual = read(pid);
  return actual === null || Math.abs(actual - started) <= START_TOLERANCE_MS;
}
