/**
 * How `revert:check` runs a PR's tests: vitest in the scratch copy, with a stripped environment, and in a CI run
 * as the agent's sandbox user (#335). The tests are the agent's code: run as the runner after the agent ended,
 * they could write the runner's files, read its keys from its home or reach the network with them. As the sandbox
 * user they can do neither: that user's packets reach loopback only (`factory-sandbox-setup.ts`), and no proxy is
 * started for them, so a test run reaches no host at all, which is narrower than the agent's allow-list. Tests that
 * need the network then fail, and the check reads as one it couldn't judge. Split from revert-check.ts, which may
 * not pass 400 lines.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SANDBOX_TMP, sandboxedCommand } from "./factory-sandbox.ts";
import { realSh, SANDBOX_USER, type Sh, sandboxProblems, stopAgentProcesses } from "./factory-sandbox-setup.ts";
import type { CheckInput, TestRun } from "./revert-check.ts";
import { parseVitestReport } from "./run-outcome.ts";

/**
 * Only what a test runner needs: no tokens, keys or other secrets from the caller's environment, and
 * `home` (the scratch folder) as the home directory, so tools that look for credentials there find none.
 * On its own this is not a sandbox: the tests still run with the caller's file access, exactly as `npm run check`
 * already runs them. In a CI run they also run as the sandbox user (`sandboxedSpawn`).
 */
export function strippedEnv(env: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv {
  const keep =
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|HOME|USERPROFILE|TEMP|TMP|TMPDIR|LANG|LC_ALL|TZ)$/i;
  const out: NodeJS.ProcessEnv = { CI: "1", NODE_ENV: "test" };
  for (const [key, value] of Object.entries(env)) if (keep.test(key)) out[key] = value;
  if (home) {
    out.HOME = home;
    out.USERPROFILE = home;
  }
  return out;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number },
) => { status: number | null; stderr?: string; error?: Error };

/**
 * A spawn that starts the program as the sandbox user, through `sudo -n -u ffagent` as the agent is started: its
 * environment kept by name, never by value on the command line, and the user's own home, path and temp folder.
 */
export function sandboxedSpawn(spawn: Spawn = spawnSync): Spawn {
  return (command, args, options) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
    const launch = sandboxedCommand(command, [...args], env);
    return spawn(launch.command, launch.args, { ...options, env: launch.env });
  };
}

/**
 * Lets the sandbox user into the scratch folder, without writing there, and read and write one copy in it, and the
 * runner whatever that user makes in the copy, so the runner can read the report and remove it afterwards. The
 * folder itself, where the runner keeps its temporary indexes and builds the next copy, stays the runner's alone
 * (Qodo on PR 336). Default entries go on folders only, as the sandbox's setup gives them: `setfacl` refuses a
 * default entry on a file (Qodo on PR 336). Throws when a step fails.
 */
export function shareWithSandbox(scratch: string, copy: string, sh: Sh = realSh, runner = userInfo().username): void {
  const u = SANDBOX_USER;
  for (const args of [
    ["setfacl", "-m", `u:${u}:x`, scratch],
    ["setfacl", "-R", "-m", `u:${u}:rwX`, copy],
    ["find", copy, "-type", "d", "-exec", "setfacl", "-m", `d:u:${u}:rwX,d:u:${runner}:rwX`, "{}", "+"],
  ]) {
    const result = sh("sudo", ["-n", ...args]);
    if (result.status !== 0) throw new Error(`couldn't share the scratch copy with the sandbox user: ${result.stderr}`);
  }
}

/** Removes a scratch folder the sandbox user wrote in, whatever it did to its own files' modes. */
export function removeShared(scratch: string, sh: Sh = realSh): void {
  if (sh("sudo", ["-n", "rm", "-rf", "--", scratch]).status !== 0) rmSync(scratch, { recursive: true, force: true });
}

/**
 * Runs vitest on the files, in the folder, with the stripped environment, and reads its JSON report.
 * The report from an earlier run is removed first: a run that dies before writing one must read as
 * "didn't run", never as the earlier run's result.
 */
export function runVitest(dir: string, files: string[], spawn: Spawn = spawnSync): TestRun {
  const vitest = join(dir, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) return { ran: false, failed: [], passed: 0, error: "vitest isn't installed in the repo" };
  const report = join(dir, ".revert-check-report.json");
  rmSync(report, { force: true });
  const result = spawn(process.execPath, [vitest, "run", ...files, "--reporter=json", `--outputFile=${report}`], {
    cwd: dir,
    env: strippedEnv(process.env, dirname(dir)),
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  // A link a test left in place of the report would have the runner read some other file (Qodo on PR 336).
  if (!existsSync(report) || lstatSync(report).isSymbolicLink()) {
    const why = (result.error?.message ?? result.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    return { ran: false, failed: [], passed: 0, error: `vitest wrote no report (exit ${result.status}): ${why}` };
  }
  return { ran: true, ...parseVitestReport(JSON.parse(readFileSync(report, "utf8"))) };
}

/**
 * How `revertCheck` runs the tests: as the caller, or with `sandboxed` as the sandbox user, in a scratch copy under
 * the system's temp folder that is shared with that user. Throws when a sandbox is asked for and isn't in place: the
 * tests never run unsandboxed instead (#335).
 */
export function testSetup(sandboxed: boolean, sh: Sh = realSh): Pick<CheckInput, "runTests" | "temp" | "sandbox"> {
  if (!sandboxed) return { runTests: runVitest };
  const missing = sandboxProblems(sh);
  if (missing.length) throw new Error(`no sandbox for the tests (${missing.join("; ")})`);
  return {
    // No process a test left behind outlives its run: it could still write after the runner looked (Qodo on PR 336).
    runTests: (dir, files) => {
      const run = runVitest(dir, files, sandboxedSpawn());
      const left = stopAgentProcesses(sh);
      return left ? { ran: false, failed: [], passed: 0, error: left } : run;
    },
    temp: SANDBOX_TMP,
    sandbox: { share: (scratch, copy) => shareWithSandbox(scratch, copy, sh), remove: (dir) => removeShared(dir, sh) },
  };
}
