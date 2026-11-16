import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_KINDS } from "../../../packages/harness/src/door/target-post.ts";
import { AGENT_DOOR_KINDS as DOOR_LIST } from "../../../packages/harness/src/door/target-post-run.ts";
import { decide } from "../factory-policy.ts";
import { GROWTH_FACTOR, growth, LINEAR_BOUND } from "../fixtures.ts";
import { AGENT_DOOR_KINDS, doorKindViolation } from "./door-kinds.ts";

const RUN = resolve("/runs/20261115-0100-target-7");
const RUN_ENV = { FAULTFORGE_FACTORY_RUN: "test", FAULTFORGE_RUN_ROOT: RUN };
const OUTSIDE = { FAULTFORGE_FACTORY_RUN: "", FAULTFORGE_RUN_ROOT: "" };
const bash = (command: string) => JSON.stringify({ tool_name: "Bash", cwd: RUN, tool_input: { command } });
const door = (kind: string) => `npm run target:post -- ${kind} --repo Owner/app --number 3 --body-file b.md`;

const allowed: readonly string[] = AGENT_DOOR_KINDS;
const others = COMMAND_KINDS.filter((kind) => !allowed.includes(kind));

describe("factory policy: the door kinds a run's agent may use, as a first layer (#347)", () => {
  it("reads the door's own list: push, pr-create and pr-edit", () => {
    expect(AGENT_DOOR_KINDS).toBe(DOOR_LIST);
    expect([...AGENT_DOOR_KINDS]).toEqual(["push", "pr-create", "pr-edit"]);
    expect([...others].sort()).toEqual(["issue-comment", "issue-create", "issue-edit", "pr-close", "pr-comment"]);
  });

  it.each(others)("refuses %s written out during a run, naming the allowed kinds", (kind) => {
    const decision = decide(bash(door(kind)), RUN_ENV);
    expect(decision).toMatchObject({ kind: "deny" });
    expect((decision as { reason: string }).reason).toContain("takes only push, pr-create, pr-edit");
  });

  it.each([
    ["npm's own options first", "npm run target:post --silent -- pr-close --number 3 --body-file b.md"],
    ["the run-script spelling", "npm run-script target:post -- issue-create --title-file t --body-file b"],
    ["after an allowed call", "npm run target:post -- push --branch x && npm run target:post -- pr-close --number 3"],
    ["Windows' npm script", "npm.ps1 run target:post -- pr-close --number 3 --body-file b.md"],
    ["a variable set first", "K=1 npm run target:post -- pr-comment --number 3 --body-file b.md"],
    ["a quoted kind", `npm run target:post -- "pr-close" --number 3 --body-file b.md`],
    ["a second command after a semicolon", "npm run target:post -- push --branch x; npm run target:post -- pr-close"],
  ])("refuses %s", (_name, command) => {
    expect(doorKindViolation(command)).toBeDefined();
  });

  it("reads a `;` inside a quoted file name as part of the name (Qodo on PR 349)", () => {
    const quoted = "'title; npm run target:post -- pr-close'";
    expect(
      doorKindViolation(`npm run target:post -- pr-create --head tidy --title-file ${quoted} --body-file b.md`),
    ).toBeUndefined();
  });

  it.each([
    "npm run target:post -- push --repo Owner/app --branch tidy",
    "npm run target:post -- pr-create --repo Owner/app --head tidy --title-file t.md --body-file b.md",
    "npm run target:post -- pr-edit --repo Owner/app --number 3 --body-file b.md",
    // Qodo on PR 349: a branch may carry any name, a kind's included.
    "npm run target:post -- push --repo Owner/app --branch pr-comment",
  ])("lets %s through during a run", (command) => {
    expect(decide(bash(command), RUN_ENV)).toEqual({ kind: "allow" });
  });

  it.each(COMMAND_KINDS.map((kind) => door(kind)))("leaves the owner's %s alone outside a run", (command) => {
    expect(decide(bash(command), OUTSIDE)).toEqual({ kind: "allow" });
  });

  it.each([
    // Qodo on PR 349: commands that read, search or test are not door calls.
    "cat packages/harness/src/door/target-post.ts README",
    "grep sendPost packages/harness/src/door/target-post.ts",
    "grep -R pr-close packages/harness/src",
    "grep -rn 'npm' packages/*.json",
    "npx vitest run packages/harness/src/target-post.test.ts -t 'import(x)'",
    "npx vitest run --reporter dot target-post.ts",
    `node -e "console.log(require('node:fs').readdirSync('.'))"`,
    "npm run check",
    "npm test -- --grep 'a (b)'",
    "git push origin tidy",
  ])("doesn't refuse %s", (command) => {
    expect(doorKindViolation(command)).toBeUndefined();
  });

  it("decides in time linear in the command's length", () => {
    expect(GROWTH_FACTOR).toBeGreaterThan(1);
    const ratio = growth((k) => {
      doorKindViolation("npm run target:post -- push ".repeat(200 * k));
      doorKindViolation(`npm run target:post ${"--x ".repeat(1000 * k)}`);
    });
    expect(ratio).toBeLessThan(LINEAR_BOUND);
  });
});
