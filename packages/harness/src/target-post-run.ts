/**
 * The door's run gate (#347). While a factory run is active, the door (`target-post.ts`) sends only the kinds a
 * run's agent needs, `AGENT_DOOR_KINDS`: push its branch, open its PR and change it. Every other kind (commenting,
 * closing a PR, writing an issue, moving a label) is refused with exit 2, whoever calls the door and however: the
 * check sits in `sendPost`, which every send goes through, not in the text of a command. The one exception is the
 * runner's own writes (`ticket-write.ts`), which pass the run's runner key.
 *
 * A run is active while its marker file exists. The runner writes it before the agent starts and removes it when
 * the tick ends (`startDoorRun`). Its path is fixed, never read from the environment, which the agent sets. It
 * holds the run's id, the runner's pid and the SHA-256 of a random key; the key itself stays in the runner's
 * memory and is never written to a file or given to the agent. A marker that can't be read counts as a run whose
 * key can't match, so the door refuses: it fails closed.
 *
 * What holds where:
 *  - In CI the agent runs as its own user (`factory-sandbox*.ts`). The marker is `/tmp/faultforge-factory-run.json`,
 *    owned by the runner's user with mode 0644, in `/tmp`, whose sticky bit lets only a file's owner remove or
 *    rename it. So the operating system keeps the agent from removing, moving or editing it, and from reading the
 *    runner's memory, where the key is.
 *  - On the owner's PC (local mode, Windows) there is no sandbox: the agent runs as the owner, who may remove the
 *    marker (`.faultforge-factory-run.json` in the owner's profile folder). There the gate stops a call through the
 *    door, but not an agent that deletes the marker first; the policy hook and the run's audit are what stand guard.
 *
 * Code that doesn't go through the door at all (raw `gh` or `git`) is not the gate's to stop: the guard hook
 * refuses every write to a reviewed repo that isn't the door (docs/target-door.md).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** The door kinds an agent may use during a run: the one list, which the policy hook and the agent's prompt read. */
export const AGENT_DOOR_KINDS = ["push", "pr-create", "pr-edit"] as const;
export type AgentDoorKind = (typeof AGENT_DOOR_KINDS)[number];

/** The refusal, naming the allowed kinds. */
export const RUN_KIND_REASON = `a factory run is active: the door takes only ${AGENT_DOOR_KINDS.join(", ")}. Commenting on or closing a PR, writing issues and moving labels stay with the owner and the runner`;

/**
 * Where the runner marks a run active, by platform, never from the environment: `/tmp` (sticky, so only its owner
 * can remove the marker) outside Windows; on Windows the profile folder Windows itself records for the user.
 */
export function runMarkerPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? join(userInfo().homedir, ".faultforge-factory-run.json")
    : "/tmp/faultforge-factory-run.json";
}

/** The marker the gate reads when a call names none. Only the unit tests' setup changes it (`vitest.setup.ts`). */
let defaultMarker: string | undefined;

/** Points the gate at another marker for calls that name none: for the test setup only. */
export function useRunMarker(path: string): void {
  defaultMarker = path;
}

/** The marker a call reads: its own, or the default. */
export const markerFor = (marker?: string) => marker ?? defaultMarker ?? runMarkerPath();

// Not provenance.ts's sha256: the door imports only files the guard holds (target-post-door.test.ts).
const keyDigest = (text: string) => createHash("sha256").update(text).digest();

/** Whether a run is active, and the hash of its runner key when the marker could be read. */
function readMarker(path: string): { active: boolean; keyHash?: Buffer } {
  try {
    lstatSync(path);
  } catch (error) {
    // No marker: no run. Any other error (a folder it can't look in) counts as a run, so the door fails closed.
    return { active: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  try {
    const { keyHash } = JSON.parse(readFileSync(path, "utf8"));
    return typeof keyHash === "string" && /^[0-9a-f]{64}$/.test(keyHash)
      ? { active: true, keyHash: Buffer.from(keyHash, "hex") }
      : { active: true };
  } catch {
    return { active: true };
  }
}

/**
 * Why the door may not send a post of this kind now, or undefined. Allowed kinds always pass; any other passes
 * only outside a run, or with the run's runner key.
 */
export function runGateRefusal(kind: string, gate: { marker?: string; runnerKey?: string } = {}): string | undefined {
  if ((AGENT_DOOR_KINDS as readonly string[]).includes(kind)) return undefined;
  const path = markerFor(gate.marker);
  const marker = readMarker(path);
  if (!marker.active) return undefined;
  if (gate.runnerKey && marker.keyHash && timingSafeEqual(keyDigest(gate.runnerKey), marker.keyHash)) return undefined;
  return `${RUN_KIND_REASON} (${kind} refused; the run's marker is ${path}: if no run is active, remove it)`;
}

/** A run the runner has marked active: its key, for the runner's own writes, and the way to end it. */
export interface DoorRun {
  /** The runner key: only the runner's process holds it. */
  key: string;
  /** Removes the marker, if it is still this run's. Never throws. */
  end(): void;
}

/**
 * Marks a run active, before the agent starts. A marker left by an earlier run that died is replaced; one the
 * runner can't remove (another user's, in `/tmp`) throws, so the run doesn't start. The file is created anew
 * (`wx`), so a link put in its place is never followed, and only its owner may write it (0644).
 */
export function startDoorRun(runId: string, marker?: string): DoorRun {
  const path = markerFor(marker);
  rmSync(path, { force: true });
  const key = randomBytes(32).toString("hex");
  const keyHash = keyDigest(key).toString("hex");
  writeFileSync(path, `${JSON.stringify({ run: runId, pid: process.pid, keyHash })}\n`, { flag: "wx", mode: 0o644 });
  return {
    key,
    end() {
      try {
        if (JSON.parse(readFileSync(path, "utf8")).keyHash === keyHash) rmSync(path, { force: true });
      } catch {
        // Already gone, or not ours: nothing to remove.
      }
    },
  };
}

/** The runner's handle on its run: started once before the agent, ended when the tick ends. */
export function doorRunHolder(marker?: string) {
  let run: DoorRun | undefined;
  return {
    /** Marks the run active, once; returns its key. */
    start(runId: string): string {
      run ??= startDoorRun(runId, marker);
      return run.key;
    },
    /** The key while a run is marked, for the runner's own writes. */
    key: () => run?.key,
    end() {
      run?.end();
      run = undefined;
    },
  };
}
