/**
 * The guardrail hooks' settings check and self-test, run before an agent starts: both hooks must run before
 * every shell command and file edit, and answer as they should, in time. Split from factory-tick.ts (#227).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "./factory-config.ts";
import { worktreeFor } from "./factory-workspace.ts";

/**
 * Why a workspace's `.claude/settings.json` isn't safe for an unattended run, or an empty list. Both the
 * guard hook and the factory policy hook must run before every shell command and file edit.
 */
/**
 * True when a hook command runs exactly this repo's hook file with node, through the fail-closed wrapper that
 * turns a crash, a broken import or a timeout into a refusal (AUD-M4), not merely mentions it.
 */
export function runsHook(command: string, file: string): boolean {
  const expected = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/fail-closed.ts" ${file}`;
  return command.trim().replace(/\\/g, "/") === expected;
}

export function hookProblems(settingsText: string): string[] {
  let hooks: { matcher?: string; hooks?: { command?: string }[] }[] = [];
  try {
    hooks = JSON.parse(settingsText).hooks?.PreToolUse ?? [];
  } catch {
    return ["its settings.json is missing or unreadable"];
  }
  const problems: string[] = [];
  for (const hook of ["guard-target.ts", "factory-policy.ts"]) {
    for (const tool of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const covered = hooks.some(
        (h) =>
          (!h.matcher || h.matcher === "*" || new RegExp(`^(${h.matcher})$`).test(tool)) &&
          (h.hooks ?? []).some((c) => runsHook(c.command ?? "", hook)),
      );
      if (!covered) problems.push(`${hook} doesn't run before ${tool}`);
    }
  }
  return problems;
}

/**
 * The shortest time limit (seconds) the settings give either hook. Claude Code's default is 60. A hook
 * that exceeds its limit is a non-blocking error, so the self-test below also checks speed.
 */
export function hookTimeoutSeconds(settingsText: string): number {
  let hooks: { hooks?: { command?: string; timeout?: number }[] }[] = [];
  try {
    hooks = JSON.parse(settingsText).hooks?.PreToolUse ?? [];
  } catch {
    return 60;
  }
  const limits = hooks
    .flatMap((h) => h.hooks ?? [])
    .filter((c) => ["guard-target.ts", "factory-policy.ts"].some((f) => runsHook(c.command ?? "", f)))
    .map((c) => (typeof c.timeout === "number" && c.timeout > 0 ? c.timeout : 60));
  return limits.length ? Math.min(...limits) : 60;
}

/** One answer from a hook run with a payload: what it printed, how it exited, and how long it took. */
export interface HookAnswer {
  stdout: string;
  status: number | null;
  ms: number;
}

/** Runs one hook file with stdin text and extra environment, as Claude Code would. */
export type HookRunner = (hook: string, stdin: string, env: Record<string, string>) => HookAnswer;

/**
 * What Claude Code would make of a hook's answer. Exit 2 is a blocking error (the tool call is refused);
 * exit 0 with no output allows; exit 0 with a well-formed PreToolUse decision is that decision. Anything
 * else is invalid: Claude Code ignores it and lets the tool run, so a deny printed without
 * `hookEventName` is not a deny (Qodo on PR 115).
 */
export function hookDecision(answer: HookAnswer): "deny" | "allow" | "ask" | "silent" | "invalid" {
  if (answer.status === 2) return "deny";
  if (answer.status !== 0) return "invalid";
  if (!answer.stdout.trim()) return "silent";
  try {
    const out = JSON.parse(answer.stdout).hookSpecificOutput;
    if (out?.hookEventName !== "PreToolUse") return "invalid";
    return ["deny", "allow", "ask"].includes(out.permissionDecision) ? out.permissionDecision : "invalid";
  } catch {
    return "invalid";
  }
}

/** What one hook answered to its three self-test payloads, and its slowest answer. */
export interface HookReport {
  hook: string;
  /** Claude Code's reading of each answer: "deny", "allow" or "silent", "ask", "invalid". */
  outcomes: { deny: string; allow: string; notJson: string };
  slowestMs: number;
}

/** The self-test's result: every problem found, and what each hook answered. */
export interface HooksReport {
  problems: string[];
  hooks: HookReport[];
}

/**
 * Proves both hooks work before an agent runs: each must deny what it exists to deny, allow a harmless
 * command, and deny when its input is not JSON (a crash would otherwise let the tool run). Each answer
 * must come well inside the time limit, since a hook that times out is also a bypass. `reviewedFolder`
 * is a reviewed repo's checkout, where the guard must block a telltale commit message. Returns the
 * problems found, or an empty list.
 */
export function hookSelfTest(lab: string, reviewedFolder: string, limitSeconds: number, run: HookRunner): string[] {
  return hookSelfTestReport(lab, reviewedFolder, limitSeconds, run).problems;
}

/** The same self-test, with each hook's three outcomes and slowest answer, for the run log (#126). */
export function hookSelfTestReport(
  lab: string,
  reviewedFolder: string,
  limitSeconds: number,
  run: HookRunner,
): HooksReport {
  const payload = (tool: string, input: object, cwd: string) =>
    JSON.stringify({ tool_name: tool, cwd, tool_input: input });
  const runEnv = { FAULTFORGE_FACTORY_RUN: "self-test", FAULTFORGE_RUN_ROOT: lab };
  const cases: {
    hook: string;
    name: string;
    kind: "deny" | "allow" | "notJson";
    stdin: string;
    env: Record<string, string>;
    expectDeny: boolean;
  }[] = [
    {
      hook: "guard-target.ts",
      name: "a telltale commit in a reviewed repo",
      kind: "deny",
      stdin: payload("Bash", { command: 'git commit -m "Fix the planted bug"' }, reviewedFolder),
      env: {},
      expectDeny: true,
    },
    {
      hook: "guard-target.ts",
      name: "a harmless command",
      kind: "allow",
      stdin: payload("Bash", { command: "npm run check" }, lab),
      env: {},
      expectDeny: false,
    },
    {
      hook: "guard-target.ts",
      name: "input that is not JSON",
      kind: "notJson",
      stdin: "not json",
      env: {},
      expectDeny: true,
    },
    {
      hook: "factory-policy.ts",
      name: "a merge inside a run",
      kind: "deny",
      stdin: payload("Bash", { command: "gh pr merge 1 --squash" }, lab),
      env: runEnv,
      expectDeny: true,
    },
    {
      hook: "factory-policy.ts",
      name: "a harmless command inside a run",
      kind: "allow",
      stdin: payload("Bash", { command: "npm run check" }, lab),
      env: runEnv,
      expectDeny: false,
    },
    {
      hook: "factory-policy.ts",
      name: "input that is not JSON",
      kind: "notJson",
      stdin: "not json",
      env: runEnv,
      expectDeny: true,
    },
  ];
  const problems: string[] = [];
  const reports = new Map<string, HookReport>();
  const budgetMs = (limitSeconds * 1000) / 2;
  for (const c of cases) {
    const answer = run(c.hook, c.stdin, c.env);
    const decision = hookDecision(answer);
    const report = reports.get(c.hook) ?? {
      hook: c.hook,
      outcomes: { deny: "", allow: "", notJson: "" },
      slowestMs: 0,
    };
    report.outcomes[c.kind] = decision;
    report.slowestMs = Math.max(report.slowestMs, answer.ms);
    reports.set(c.hook, report);
    const detail = `decision ${decision}, exit ${answer.status}, output ${JSON.stringify(answer.stdout.trim().slice(0, 80))}`;
    if (c.expectDeny && decision !== "deny") problems.push(`${c.hook} let through ${c.name} (${detail})`);
    // A harmless command must pass without a question: in an unattended run nobody answers an "ask".
    if (!c.expectDeny && decision !== "silent" && decision !== "allow")
      problems.push(`${c.hook} refused ${c.name} (${detail})`);
    if (answer.ms > budgetMs)
      problems.push(
        `${c.hook} took ${answer.ms} ms on ${c.name}; it must answer within half its ${limitSeconds} s limit`,
      );
  }
  return { problems, hooks: [...reports.values()] };
}

/** A failed settings check or self-test, carrying what the check saw so the run log can record it. */
export class HooksCheckError extends Error {
  readonly report: HooksReport;
  constructor(message: string, report: HooksReport) {
    super(message);
    this.name = "HooksCheckError";
    this.report = report;
  }
}

/**
 * The error to throw when a failed start's cleanup also left something behind: the original message plus
 * what could not be removed. A HooksCheckError stays one, with its report, so the run log still records
 * the failed hook check (Qodo's local review of #126); any other error becomes a plain Error as before.
 */
export function withCleanupFailure(error: unknown, leftovers: string[]): Error {
  if (!leftovers.length) return error instanceof Error ? error : new Error(String(error));
  const message = `${error instanceof Error ? error.message : String(error)}; cleanup also failed: ${leftovers.join("; ")}`;
  return error instanceof HooksCheckError ? new HooksCheckError(message, error.report) : new Error(message);
}

/** The `hooks-checked` log event for a report: each hook's outcomes, the slowest answer, and any problems. */
export function hooksEvent(report: HooksReport): Record<string, unknown> {
  return {
    ok: report.problems.length === 0,
    hooks: report.hooks,
    slowestMs: Math.max(0, ...report.hooks.map((h) => h.slowestMs)),
    problems: report.problems,
  };
}

/** Runs a hook file from the workspace's `.claude/hooks` with node, through the wrapper, the way settings.json does. */
export function realHookRunner(lab: string, limitSeconds: number): HookRunner {
  return (hook, stdin, env) => {
    const started = Date.now();
    const hooks = join(lab, ".claude", "hooks");
    const result = spawnSync(process.execPath, [join(hooks, "fail-closed.ts"), join(hooks, hook)], {
      input: stdin,
      encoding: "utf8",
      env: {
        ...process.env,
        FAULTFORGE_FACTORY_RUN: "",
        FAULTFORGE_RUN_ROOT: "",
        FAULTFORGE_TICKET_NUMBER: "",
        ...env,
      },
      timeout: limitSeconds * 1000,
    });
    return { stdout: result.stdout ?? "", status: result.status, ms: Date.now() - started };
  };
}

/**
 * Refuses to start the agent unless both hooks run before every shell command and file edit, and
 * unless each hook, run once with payloads it must deny and allow, answers as it should and in time.
 */
export function requireHooks(factory: FactoryConfig, lab: string): HooksReport {
  const settings = join(lab, ".claude", "settings.json");
  const text = existsSync(settings) ? readFileSync(settings, "utf8") : "";
  const missing = hookProblems(text);
  if (missing.length)
    throw new HooksCheckError(`the workspace's hooks aren't safe to run unattended: ${missing.join("; ")}`, {
      problems: missing,
      hooks: [],
    });
  const reviewed = Object.values(factory.repos).find((r) => r.guard === "reviewed");
  const reviewedFolder = reviewed ? worktreeFor(lab, reviewed.path) : lab;
  const limit = hookTimeoutSeconds(text);
  const report = hookSelfTestReport(lab, reviewedFolder, limit, realHookRunner(lab, limit));
  if (report.problems.length)
    throw new HooksCheckError(`the workspace's hooks failed their self-test: ${report.problems.join("; ")}`, report);
  return report;
}
