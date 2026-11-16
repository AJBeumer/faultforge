/**
 * Telling one process from another that later got the same pid: after a crash or a restart the system hands a
 * pid on. A process is the one recorded when its pid is alive and its start id matches. Used for the lock's holder.
 *
 * The start id is what the system stores for the process's start, read the same way both times, so a clock step
 * in between changes neither reading: Linux's clock ticks after boot, Windows' creation time (CIM, which a
 * standard user can read for other users' processes too), and `ps`'s start elsewhere.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Linux: the process's start in clock ticks after boot, field 22 of `/proc/<pid>/stat`. */
function linuxStartId(pid: number): string | null {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The second field (the program name, in brackets) can hold spaces; the rest follow its closing bracket.
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return ticks && /^\d+$/.test(ticks) ? `ticks:${ticks}` : null;
}

/** Windows: the process's creation time, as CIM gives it. */
function windowsStartId(pid: number): string | null {
  const out = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const text = (out.stdout ?? "").trim();
  return out.status === 0 && Number.isFinite(Date.parse(text)) ? `created:${text}` : null;
}

/** Elsewhere: `ps`, to the second, in UTC. */
function psStartId(pid: number): string | null {
  // `lstart` is printed in local time, so pin it to UTC whatever the zone or the season.
  const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, TZ: "UTC" },
  });
  const text = (out.stdout ?? "").trim();
  return out.status === 0 && text ? `lstart:${text}` : null;
}

/** The start id of the process with `pid`, or null when it can't be read. */
export function processStartId(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") return linuxStartId(pid);
    if (process.platform === "win32") return windowsStartId(pid);
    return psStartId(pid);
  } catch {
    return null;
  }
}

/**
 * True when the live process `pid` is the one whose start id was recorded as `started`. No id recorded, or one
 * the system won't give, counts as the same process: a process is only taken for another on evidence.
 */
export function sameProcess(
  pid: number,
  started: string | undefined,
  read: (pid: number) => string | null = processStartId,
): boolean {
  if (!started) return true;
  const actual = read(pid);
  return actual === null || actual === started;
}

let own: string | null | undefined;

/** This process's own start id, read once: it never changes while the process runs. */
export function ownStartId(): string | null {
  if (own === undefined) own = processStartId(process.pid);
  return own;
}
