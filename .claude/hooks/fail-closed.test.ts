/**
 * The fail-closed wrapper Claude Code runs for each hook (AUD-M4): it passes on only a clean answer, and refuses
 * a hook that can't load, crashes, runs past its budget, answers in a way Claude Code would ignore, or is no
 * longer the hook it names. Broken hooks are written to the temp folder.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answer, hookFileProblem, MIN_HOOK_BYTES, run } from "./fail-closed.ts";
import { guardConfig, tempRepo } from "./fixtures.ts";

describe("the hook fails closed outside decide()", () => {
  const CONFIG = guardConfig(tempRepo(true).dir);
  const WRAPPER = join(import.meta.dirname, "fail-closed.ts");
  const scratch = mkdtempSync(join(tmpdir(), "guard-broken-"));
  const module = (name: string, text: string) => {
    const file = join(scratch, name);
    writeFileSync(file, text);
    return file;
  };
  const viaWrapper = (hook: string, stdin = "{}", env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [WRAPPER, hook], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, FAULTFORGE_CONFIG: CONFIG, ...env },
    });

  it.each([
    ["throws on import", module("throws.mjs", 'throw new Error("boom on import");\n')],
    ["imports a module that is missing", module("missing.mjs", 'import "./not-there.mjs";\n')],
    ["has a syntax error", module("syntax.mjs", "export const = ;\n")],
    ["exits 1", module("one.mjs", "process.exit(1);\n")],
    ["prints something that isn't a decision", module("noise.mjs", 'console.log("allowed, probably");\n')],
  ])("exits 2 for a hook that %s", (_name, hook) => {
    const result = viaWrapper(hook);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/refused/);
  });

  it("exits 2 for a hook that runs past its budget", () => {
    // Shaped like a hook, so the wrapper's file check passes and the budget is what stops it.
    const hang = module(
      "hang.mjs",
      `export function decide() {}\nconst isEntry = () => true;\nconst main = () => setTimeout(() => {}, 60_000);\n// ${"x".repeat(2000)}\nif (isEntry(import.meta.url)) main();\n`,
    );
    const result = run([hang], () => Buffer.from("{}"), 300);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no answer within/);
  });

  it("passes the real guard's answers on: a deny, an allow, and its own refusal", () => {
    const payload = (command: string, cwd: string) =>
      JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
    const denied = viaWrapper("guard-target.ts", payload("git push origin main", "D:\\Projects\\faultforge-target"));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const allowed = viaWrapper("guard-target.ts", payload("npm run check", "D:\\Projects\\FaultForge"));
    expect([allowed.status, allowed.stdout]).toEqual([0, ""]);
    expect(viaWrapper("guard-target.ts", "not json").status).toBe(2);
    expect(viaWrapper("factory-policy.ts", "not json", { FAULTFORGE_FACTORY_RUN: "test" }).status).toBe(2);
  });
});

describe("the wrapper passes on only an answer Claude Code acts on", () => {
  it("refuses a hook answer Claude Code would ignore: another event, or a decision it doesn't know", () => {
    const event = (hookEventName: string, permissionDecision: string) =>
      JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision } });
    expect(answer("h", { status: 0, stdout: event("PostToolUse", "deny"), stderr: "" }).code).toBe(2);
    expect(answer("h", { status: 0, stdout: event("PreToolUse", "maybe"), stderr: "" }).code).toBe(2);
    expect(answer("h", { status: 0, stdout: event("PreToolUse", "deny"), stderr: "" }).code).toBe(0);
  });
});

describe("the fail-closed wrapper refuses a hook file that can't be the hook", () => {
  const scratch = mkdtempSync(join(tmpdir(), "guard-hookfile-"));
  const file = (name: string, text: string) => {
    const path = join(scratch, name);
    writeFileSync(path, text);
    return path;
  };
  const real = join(import.meta.dirname, "guard-target.ts");

  it("accepts both real hooks", () => {
    expect(hookFileProblem(real)).toBeUndefined();
    expect(hookFileProblem(join(import.meta.dirname, "factory-policy.ts"))).toBeUndefined();
  });

  it.each([
    ["emptied", ""],
    ["truncated", "export function decide(stdin) {\n"],
    ["a one-line allow", "process.exit(0)"],
    ["padded but without decide", `// ${"x".repeat(MIN_HOOK_BYTES)}\nif (isEntry(import.meta.url)) main();\n`],
    ["padded with decide but no entry point", `export function decide() {}\n// ${"x".repeat(MIN_HOOK_BYTES)}\n`],
  ])("refuses a hook file %s", (_name, text) => {
    const hook = file(`${_name.replace(/\W+/g, "-")}.ts`, text);
    expect(hookFileProblem(hook)).toBeDefined();
    const result = run([hook], () => Buffer.from("{}"));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/refused/);
  });
});
