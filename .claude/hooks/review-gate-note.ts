/**
 * Claude Code PostToolUse hook. After a `git commit` in this repository it runs `review:gate` on the new
 * commit and, when no finished local review saw those exact files, says so. It warns and never blocks: it
 * runs after the commit, answers nothing the tool call depends on, and any failure ends in silence or a note.
 *
 * It checks the commit that was made (`--commit HEAD`), not the staged files before it, so `git commit -a`,
 * `git add … && git commit` in one command and an amend are all judged on what was really committed.
 *
 * Silent when: the command is not a `git commit`, it targets another repository (`git -C`, `cd`), it is a dry
 * run, the run is an unattended factory run (the runner has its own gates), or `FAULTFORGE_GATE=off`.
 *
 * `decide()` takes the hook payload as text and a runner for the gate, and returns a note or nothing without
 * printing, so the tests call it in-process. Run as `node <this file>`, `main()` reads stdin and answers.
 * Exit codes of the gate: 0 covered, 1 not covered, 2 could not check (anything else counts as 2).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstLine, isEntry, readStdin } from "./hook-io.ts";

export type Note = { kind: "none" } | { kind: "note"; message: string };
export const NONE: Note = { kind: "none" };

/** What running `review:gate` on HEAD gave: its exit code and what it printed. */
export interface GateRun {
  exitCode: number | null;
  output: string;
}
/** Runs the gate on a commit (a hash from git's own summary line, or HEAD). */
export type GateRunner = (ref: string) => GateRun;

/** What the hook needs from the world, so a test can supply it. */
export interface Deps {
  run: GateRunner;
  /** How old HEAD is in seconds, or null when git cannot say. */
  headAge: () => number | null;
  /** Whether the folder the tool ran in belongs to this project's own repository. */
  inProject: (cwd: string) => boolean;
}

// Anything git accepts between `git` and `commit`: `-c k=v`, `-C dir`, `--no-pager`, `--git-dir=x`, `-p`.
const GIT_OPTIONS = String.raw`(?:(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?|-[pP])\s+)*`;
const COMMIT = new RegExp(String.raw`(^|[\s;&|(])git\s+${GIT_OPTIONS}commit\b`, "i");
// Case matters for git's own flags: `-C` (another folder) is not `-c` (a setting).
const GIT_ELSEWHERE = new RegExp(String.raw`\bgit\s+${GIT_OPTIONS.replace("[cC]", "c")}(-C|--git-dir|--work-tree)\b`);
const SHELL_ELSEWHERE = /\b(cd|pushd|Set-Location)\s/i;
// Moving to the current folder is not moving elsewhere: `git -C . commit`, `cd . && git commit`.
const STAYS_HERE = /\bgit\s+-C\s+\.(?=\s)|\b(cd|pushd|Set-Location)\s+\.(?=\s|;|&|$)/gi;

/**
 * The command without what is only text: everything from a here-document marker on, and any quoted
 * string. A commit message that says "cd x" or "git commit" is not a command, and must neither silence
 * the hook nor trigger it.
 */
export function withoutText(command: string): string {
  const heredoc = command.indexOf("<<");
  const head = heredoc >= 0 ? command.slice(0, heredoc) : command;
  return head.replace(/"[^"]*"|'[^']*'/g, "");
}

/** True for a command that makes a commit in this repository, as far as the text shows. */
export function isOwnCommit(command: string): boolean {
  const code = withoutText(command).replace(STAYS_HERE, (m) => (/^git/i.test(m) ? "git" : ""));
  if (!COMMIT.test(code)) return false;
  if (GIT_ELSEWHERE.test(code) || SHELL_ELSEWHERE.test(code)) return false;
  if (/--dry-run\b/.test(code)) return false;
  return true;
}

/** git's summary line for a made commit: `[branch abc1234] message`. */
const COMMIT_SUMMARY = /\[[^\]\n]+ [0-9a-f]{7,40}\]/;

/** The text a tool answered with, whatever shape the answer has, or null when there is none. */
function outputText(response: unknown): string | null {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    const r = response as { stdout?: unknown; output?: unknown };
    const text = [r.stdout, r.output].filter((v): v is string => typeof v === "string").join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

/** How old HEAD is, in seconds, or null when git cannot say. */
export function headAgeSeconds(projectDir: string): number | null {
  const result = spawnSync("git", ["-C", projectDir, "log", "-1", "--format=%ct"], { encoding: "utf8", timeout: 5000 });
  const made = Number(result.stdout?.trim());
  return result.status === 0 && Number.isFinite(made) ? Math.max(0, Date.now() / 1000 - made) : null;
}

/** Output that says no commit was made. */
const NO_COMMIT = /nothing (added )?to commit|no changes added|^(error|fatal):|aborting commit|\n(error|fatal):/i;

/**
 * The commit that command made, to be judged: the hash in git's own summary line (so a later `git checkout`
 * in the same command cannot change which commit is checked), else HEAD when it is under two minutes old and
 * the output does not say the commit failed (a quiet `-q` commit prints no summary). Null when none was made:
 * a failed commit leaves HEAD on an older commit, which must not be judged.
 */
export function madeCommit(response: unknown, headAge: () => number | null): string | null {
  const text = outputText(response);
  const summary = text?.match(COMMIT_SUMMARY)?.[0];
  if (summary) return summary.replace(/^\[[^\]]* |\]$/g, "");
  if (text !== null && NO_COMMIT.test(text)) return null;
  const age = headAge();
  return age !== null && age < 120 ? "HEAD" : null;
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
  const p = payload as {
    tool_name?: unknown;
    cwd?: unknown;
    tool_input?: { command?: unknown };
    tool_response?: unknown;
  } | null;
  if (p?.tool_name !== "Bash" && p?.tool_name !== "PowerShell") return NONE;
  const command = p.tool_input?.command;
  if (typeof command !== "string" || !isOwnCommit(command)) return NONE;
  // The folder the tool ran in must be this project's own repository, not another one it happened to be in.
  if (typeof p.cwd === "string" && !deps.inProject(p.cwd)) return NONE;
  const ref = madeCommit(p.tool_response, deps.headAge);
  if (ref === null) return NONE;

  let result: GateRun;
  try {
    result = deps.run(ref);
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
  const top = (dir: string) => {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? resolve(r.stdout.trim()) : null;
  };
  const mine = top(projectDir);
  return mine !== null && mine === top(cwd);
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
    show(
      decide(readStdin(), {
        run: (ref) => runGate(projectDir, ref),
        headAge: () => headAgeSeconds(projectDir),
        inProject: (cwd) => sameRepository(projectDir, cwd),
      }),
    );
  } catch {
    // After the commit there is nothing to undo, and a hook that crashed must not look like a failed commit.
  }
}

if (isEntry(import.meta.url)) main();
