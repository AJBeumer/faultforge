/**
 * The alert's wiring (#308), read from the workflow files themselves: a red main and a factory tick that ends with
 * exit 2 or 3 call the one alert workflow, which alone holds `issues: write` and the lab's own token, and posts
 * only what alert.ts builds from fixed words.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KINDS } from "./alert.ts";

const root = join(import.meta.dirname, "../../..");
const read = (name: string) => readFileSync(join(root, ".github/workflows", name), "utf8");
const alert = read("alert.yml");
const check = read("check.yml");
const factory = read("factory.yml");

/** The text of one top-level job, from its key to the next job's. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) return "";
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("the alert workflow (#308)", () => {
  it("is only called, never started by an event of its own", () => {
    expect(alert).toMatch(/\non:\n {2}workflow_call:\n/);
    expect(alert).not.toMatch(/\n {2}(push|pull_request|issues|schedule|workflow_run|workflow_dispatch):/);
  });

  it("grants nothing at the top and issues: write to its one job, with the lab's own token and no secret", () => {
    expect(alert).toMatch(/\npermissions: \{\}\n/);
    const raise = job(alert, "alert");
    expect(raise).toMatch(/\n {4}permissions:\n {6}contents: read\n {6}issues: write\n/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(raise).toContain("GH_TOKEN: ${{ github.token }}");
    expect(alert).not.toMatch(/secrets\./);
  });

  it("checks out only the script, keeps no token, and installs nothing", () => {
    expect(alert).toContain("sparse-checkout: packages/harness/src/alert.ts");
    expect(alert).toContain("persist-credentials: false");
    expect(alert).not.toMatch(/npm (ci|install)/);
  });

  it("passes the inputs through the environment, never pasted into the shell", () => {
    const run = alert.match(/\n {8}run: (.*)\n?/)?.[1] ?? "";
    expect(run).toBe('node packages/harness/src/alert.ts "$KIND" "$OUTCOME"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions, not a JS template
    expect(alert).toContain("KIND: ${{ inputs.kind }}");
    expect(run).not.toContain("${{");
  });

  it("raises one kind at a time, so two failures can't open two issues", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(job(alert, "alert")).toMatch(
      /concurrency:\n {6}group: alert-\$\{\{ inputs\.kind \}\}\n {6}cancel-in-progress: false/,
    );
  });
});

describe("who raises it (#308)", () => {
  it("check.yml: after every job, on a failure of a push to main only", () => {
    const caller = job(check, "alert");
    expect(caller).toContain("needs: [check, check-windows, integration]");
    expect(caller).toContain("if: failure() && github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(caller).toContain("uses: ./.github/workflows/alert.yml");
    expect(caller).toMatch(/kind: ci-main\n\s*outcome: failure/);
    expect(caller).toMatch(/\n {4}permissions:\n {6}contents: read\n {6}issues: write\n/);
    // No other job in check.yml may write issues.
    expect(check.match(/^ +issues: write$/gm)).toHaveLength(1);
  });

  it("factory.yml: after the tick, on exit 2 or 3 only", () => {
    const caller = job(factory, "alert");
    expect(caller).toContain("needs: tick");
    expect(caller).toContain("if: always() && (needs.tick.outputs.code == '2' || needs.tick.outputs.code == '3')");
    expect(caller).toContain("uses: ./.github/workflows/alert.yml");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(caller).toContain("outcome: ${{ needs.tick.outputs.code }}");
    expect(factory.match(/^ +issues: write$/gm)).toHaveLength(1);
    // The tick job hands its exit code on, as the step records it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(job(factory, "tick")).toContain("code: ${{ steps.tick.outputs.code }}");
    expect(factory).toContain('echo "code=$code" >> "$GITHUB_OUTPUT"');
  });

  it("asks only for outcomes alert.ts knows", () => {
    expect(Object.keys(KINDS["ci-main"]?.outcomes ?? {})).toContain("failure");
    expect(Object.keys(KINDS.factory?.outcomes ?? {}).sort()).toEqual(["2", "3"]);
  });
});
