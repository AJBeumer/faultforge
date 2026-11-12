/**
 * Claude Code PostToolUse hook. After a Bash or PowerShell command it asks git whether a commit was just
 * made in this repository, and if so runs `review:gate` on it and, when no finished local review saw
 * those exact files, says so. It warns and never blocks: it runs after the command, answers nothing the
 * tool call depends on, and any failure ends in silence or a note.
 *
 * It does not read the command text. Whether a command is a commit, an amend, quiet, aliased, quoted,
 * chained or commented is not guessed: git is asked instead. A commit was made when HEAD moved since the
 * last time this hook looked (saved in `.git/faultforge-gate-last-head`) and the newest reflog entry is a
 * commit. That excludes a checkout, a failed or dry-run commit (HEAD did not move) and another repository
 * (the folder the tool ran in must belong to this one). If one command makes several commits, the last is
 * judged. The first run has nothing to compare with, so it only records HEAD.
 *
 * Silent when the run is an unattended factory run (the runner has its own gates) or `FAULTFORGE_GATE=off`.
 *
 * `decide()` takes the hook payload as text and the world as `Deps`, and returns a note or nothing without
 * printing, so the tests call it in-process. Run as `node <this file>`, `main()` reads stdin and answers.
 * Exit codes of the gate: 0 covered, 1 not covered, 2 could not check (anything else counts as 2).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstLine, isEntry, readStdin } from "./hook-io.ts";

export type Note = { kind: "none" } | { kind: "note"; message: string };
export const NONE: Note = { kind: "none" };

/** What running `review:gate` on a commit gave: its exit code and what it printed. */
export interface GateRun {
  exitCode: number | null;
  output: string;
}

/** HEAD's hash and the subject of the newest reflog entry (`commit: msg`, `checkout: moving …`). */
export interface HeadState {
  sha: string;
  lastAction: string;
}

/** What the hook needs from the world, so a test can supply it. */
export interface Deps {
  /** Runs the gate on a commit. */
  run: (ref: string) => GateRun;
  /** Whether the folder the tool ran in belongs to this project's own repository. */
  inProject: (cwd: string) => boolean;
  /** HEAD now, or null when git cannot say. */
  head: () => HeadState | null;
  /** The HEAD this hook saw last time, or null when it has not looked before. */
  readLast: () => string | null;
  saveLast: (sha: string) => void;
}

const HOW =
  "Run `npm run review:local -- faultforge --isolated` on the change (before committing next time), or accept " +
  "that this commit was reviewed only on its pull request. Silence this with FAULTFORGE_GATE=off.";

export function decide(stdin: string, deps: Deps, env: Record<string, string | undefined> = process.env): Note {
  if (env.FAULTFORGE_FACTORY_RUN || env.FAULTFORGE_GATE === "off") return NONE;
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return NONE;
  }
  const p = payload as { tool_name?: unknown; cwd?: unknown } | null;
  if (p?.tool_name !== "Bash" && p?.tool_name !== "PowerShell") return NONE;
  // The folder the tool ran in must be this project's own repository, not another one it happened to be in.
  if (typeof p.cwd === "string" && !deps.inProject(p.cwd)) return NONE;

  const head = deps.head();
  if (head === null) return NONE;
  const last = deps.readLast();
  try {
    deps.saveLast(head.sha);
  } catch {
    // Nothing to undo: the worst case is that the same commit is judged once more.
  }
  if (last === null || last === head.sha) return NONE;
  if (!/^commit/.test(head.lastAction)) return NONE;

  let result: GateRun;
  try {
    result = deps.run(head.sha);
  } catch (error) {
    return { kind: "note", message: `review:gate could not check this commit: ${firstLine(error)}` };
  }
  if (result.exitCode === 0) return NONE;
  if (result.exitCode === 1) {
    const first =
      result.output.split(String.fromCharCode(10)).find((l) => l.startsWith("Not covered")) ?? "Not covered.";
    return {
      kind: "note",
      message: `No finished local review saw the files of this commit. ${first} ${HOW}`,
    };
  }
  return { kind: "note", message: "review:gate could not check this commit (exit 2: unreadable evidence or tree)." };
}

function git(dir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** HEAD's hash and newest reflog subject in the project's repository. */
export function readHead(projectDir: string): HeadState | null {
  const sha = git(projectDir, ["rev-parse", "HEAD"]);
  const lastAction = git(projectDir, ["reflog", "-1", "--format=%gs"]);
  return sha && lastAction !== null ? { sha, lastAction } : null;
}

/** Where the last-seen HEAD is kept: inside the git folder, so it is never committed or shown as a change. */
function stateFile(projectDir: string): string | null {
  const path = git(projectDir, ["rev-parse", "--git-path", "faultforge-gate-last-head"]);
  return path ? resolve(projectDir, path) : null;
}

/** Runs the gate on a commit from the project folder, within the hook's own time limit. */
export function runGate(projectDir: string, ref: string): GateRun {
  // Node runs the TypeScript file itself (as it does for the hooks), so no shell and no npm are needed.
  const script = resolve(projectDir, "packages", "harness", "src", "review-gate.ts");
  const result = spawnSync(process.execPath, [script, "faultforge", "--commit", ref], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** True when `cwd` is inside the same git repository as the project folder (not a nested one such as `private/`). */
export function sameRepository(projectDir: string, cwd: string): boolean {
  const mine = git(projectDir, ["rev-parse", "--show-toplevel"]);
  const there = git(cwd, ["rev-parse", "--show-toplevel"]);
  return mine !== null && there !== null && resolve(mine) === resolve(there);
}

/** Prints a note the way a PostToolUse hook shows one: to the person, and as context to the agent. */
export function show(note: Note): void {
  if (note.kind === "none") return;
  console.log(
    JSON.stringify({
      systemMessage: note.message,
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note.message },
    }),
  );
}

function main() {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const file = stateFile(projectDir);
    show(
      decide(readStdin(), {
        run: (ref) => runGate(projectDir, ref),
        inProject: (cwd) => sameRepository(projectDir, cwd),
        head: () => readHead(projectDir),
        readLast: () => {
          try {
            return file ? readFileSync(file, "utf8").trim() || null : null;
          } catch {
            return null;
          }
        },
        saveLast: (sha) => {
          if (file) writeFileSync(file, `${sha}\n`);
        },
      }),
    );
  } catch {
    // After the commit there is nothing to undo, and a hook that crashed must not look like a failed commit.
  }
}

if (isEntry(import.meta.url)) main();
