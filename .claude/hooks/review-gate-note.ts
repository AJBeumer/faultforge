/**
 * Claude Code PostToolUse hook. After a Bash or PowerShell command it asks git whether a commit was just
 * made in this repository, and if so runs `review:gate` on it and, when no finished local review saw
 * those exact files, says so. It warns and never blocks: it runs after the command, answers nothing the
 * tool call depends on, and any failure ends in silence or a note.
 *
 * It does not read the command text. Whether a command is a commit, an amend, quiet, aliased, quoted,
 * chained or commented is not guessed: git is asked instead. Run as `node <this file> before`, it records
 * HEAD before a command and judges nothing; the record is one small file per tool call (Claude Code's
 * `tool_use_id`) in `.git/faultforge-gate-heads/` of the repository the command runs in, so parallel commands
 * never share one and a linked worktree has its own. Run with no argument, after a command, it judges: a commit
 * was made during the command when HEAD moved since that call's record and the newest reflog entry is a commit.
 * That excludes a commit made between commands (already recorded), a checkout, a failed or dry-run commit
 * (HEAD did not move) and another repository (the folder the tool ran in must belong to this one). If one
 * command makes several commits, the last is judged. Without a record to compare with, nothing is judged.
 *
 * Silent when the run is an unattended factory run (the runner has its own gates) or `FAULTFORGE_GATE=off`.
 *
 * `decide()` takes the hook payload as text and the world as `Deps`, and returns a note or nothing without
 * printing, so the tests call it in-process. Run as `node <this file>`, `main()` reads stdin and answers.
 * Exit codes of the gate: 0 covered, 1 not covered, 2 could not check (anything else counts as 2).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  /** The HEAD recorded before this tool call (`key` names the call), or null when none was recorded. */
  readLast: (key: string) => string | null;
  saveLast: (key: string, sha: string) => void;
  /** Forgets a call's record once it has been judged. */
  clearLast: (key: string) => void;
  /** Whether this commit was already judged (by this or another call), so it is warned about once. */
  wasJudged: (sha: string) => boolean;
  markJudged: (sha: string) => void;
}

/** Names one tool call: Claude Code's own id for it, so commands running in parallel each keep their own
 * record. Without an id every call shares one record. */
export function callKey(payload: { tool_use_id?: unknown } | null): string {
  const id = payload?.tool_use_id;
  return typeof id === "string" && id !== "" ? id : "default";
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
  const p = payload as { tool_name?: unknown; cwd?: unknown; tool_use_id?: unknown } | null;
  if (p?.tool_name !== "Bash" && p?.tool_name !== "PowerShell") return NONE;
  // The folder the tool ran in must be this project's own repository, not another one it happened to be in.
  if (typeof p.cwd === "string" && !deps.inProject(p.cwd)) return NONE;

  const head = deps.head();
  if (head === null) return NONE;
  const key = callKey(p);
  const last = deps.readLast(key);
  try {
    deps.clearLast(key);
  } catch {
    // Nothing to undo: the record is only ever read back by this same call.
  }
  if (last === null || last === head.sha) return NONE;
  if (!/^commit/.test(head.lastAction)) return NONE;
  // Several commands that started at the same HEAD all see a commit one of them made: judge it once.
  try {
    if (deps.wasJudged(head.sha)) return NONE;
    deps.markJudged(head.sha);
  } catch {
    // If this cannot be recorded, a commit may be warned about twice; that is the safer way to be wrong.
  }

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

/** Where the per-call records are kept: inside the git folder of the repository the command ran in, so they
 * are never committed or shown as a change, and a linked worktree has its own. One small file per call, so
 * parallel commands never write the same file. */
function stateDir(projectDir: string): string | null {
  const path = git(projectDir, ["rev-parse", "--git-path", "faultforge-gate-heads"]);
  return path ? resolve(projectDir, path) : null;
}

/** A file name for a key: letters, digits, dash and underscore only. */
function fileFor(dir: string, key: string): string {
  return join(dir, key.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Removes records more than a day old: a call that never finished. A call still running is never newer-evicted,
 * only a record nobody has touched for a day goes. */
function prune(dir: string, maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (now - statSync(join(dir, name)).mtimeMs > maxAgeMs) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // best effort
  }
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

/** The shared git folder of the repository a folder belongs to: the same for the main checkout and every
 * linked worktree of it, different for a nested repository such as `private/`. */
function commonDir(dir: string): string | null {
  const out = git(dir, ["rev-parse", "--git-common-dir"]);
  if (!out) return null;
  const path = resolve(dir, out);
  // Real paths, so a short and a long spelling of one folder (Windows 8.3 names, a junction) compare equal.
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** True when `cwd` belongs to the same git repository as the project folder, including its linked
 * worktrees, and not to a nested or unrelated one. */
export function sameRepository(projectDir: string, cwd: string): boolean {
  const mine = commonDir(projectDir);
  const there = commonDir(cwd);
  return mine !== null && there !== null && mine === there;
}

/**
 * Before a command: remember HEAD, and judge nothing. A commit made between two commands (in an IDE or a
 * terminal) is then already known when the command after it finishes, so only a commit made during a
 * command is ever judged after it.
 */
export function recordHead(stdin: string, deps: Deps, env: Record<string, string | undefined> = process.env): void {
  if (env.FAULTFORGE_FACTORY_RUN || env.FAULTFORGE_GATE === "off") return;
  try {
    const p = JSON.parse(stdin) as { tool_name?: unknown; cwd?: unknown; tool_use_id?: unknown } | null;
    if (p?.tool_name !== "Bash" && p?.tool_name !== "PowerShell") return;
    if (typeof p.cwd === "string" && !deps.inProject(p.cwd)) return;
    const head = deps.head();
    if (head !== null) deps.saveLast(callKey(p), head.sha);
  } catch {
    // Recording is best effort: a missed record only means one commit is judged a command late.
  }
}

/** Prints a note the way a PostToolUse hook shows one: to the person, and as context to the agent. */
export function show(note: Note, event = "PostToolUse"): void {
  if (note.kind === "none") return;
  console.log(
    JSON.stringify({
      systemMessage: note.message,
      hookSpecificOutput: { hookEventName: event, additionalContext: note.message },
    }),
  );
}

/** The world for a payload: HEAD and the saved state of the repository the command ran in (the main checkout
 * or a linked worktree of it), and the gate, which always runs from the project folder. */
export function realDeps(projectDir: string, stdin: string): Deps {
  let cwd = projectDir;
  try {
    const given = (JSON.parse(stdin) as { cwd?: unknown } | null)?.cwd;
    if (typeof given === "string" && given) cwd = given;
  } catch {
    // an unreadable payload is judged as no commit by decide()
  }
  const dir = stateDir(cwd);
  return {
    run: (ref) => runGate(projectDir, ref),
    inProject: (dir) => sameRepository(projectDir, dir),
    head: () => readHead(cwd),
    readLast: (key) => {
      try {
        return dir ? readFileSync(fileFor(dir, key), "utf8").trim() || null : null;
      } catch {
        return null;
      }
    },
    saveLast: (key, sha) => {
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(fileFor(dir, key), sha + String.fromCharCode(10));
      prune(dir);
    },
    clearLast: (key) => {
      if (dir) rmSync(fileFor(dir, key), { force: true });
    },
    wasJudged: (sha) => (dir ? existsSync(fileFor(dir, `judged-${sha}`)) : false),
    markJudged: (sha) => {
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(fileFor(dir, `judged-${sha}`), sha + String.fromCharCode(10));
    },
  };
}

/** The event the payload says it is: a failed command reaches the hook as PostToolUseFailure. */
export function eventOf(stdin: string): string {
  try {
    const name = (JSON.parse(stdin) as { hook_event_name?: unknown } | null)?.hook_event_name;
    return name === "PostToolUseFailure" ? name : "PostToolUse";
  } catch {
    return "PostToolUse";
  }
}

/** `node review-gate-note.ts before` records HEAD before a command; with no argument it judges after one. */
function main() {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const stdin = readStdin();
    const deps = realDeps(projectDir, stdin);
    if (process.argv[2] === "before") recordHead(stdin, deps);
    else show(decide(stdin, deps), eventOf(stdin));
  } catch {
    // After the commit there is nothing to undo, and a hook that crashed must not look like a failed commit.
  }
}

if (isEntry(import.meta.url)) main();
