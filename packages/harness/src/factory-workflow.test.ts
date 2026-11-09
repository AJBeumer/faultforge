/**
 * The factory workflow's safety properties, read from the file itself so a later edit can't drop one
 * quietly. Plain text checks: the workflow is small and these lines are its contract.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFactory } from "./factory-config.ts";

const root = join(import.meta.dirname, "../../..");
const workflow = readFileSync(join(root, ".github/workflows/factory.yml"), "utf8");

describe("factory workflow", () => {
  it("starts on the label, a schedule, and by hand", () => {
    expect(workflow).toMatch(/issues:\s*\n\s*types: \[labeled\]/);
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: "\*\/15 \* \* \* \*"/);
    expect(workflow).toMatch(/workflow_dispatch:/);
  });

  it("only reacts to the owner's label, the owner's dispatch, or the schedule", () => {
    expect(workflow).toContain("github.event.label.name == 'ready-for-agent'");
    expect(workflow).toContain("github.event.sender.login == github.repository_owner");
    expect(workflow).toContain("(github.event_name == 'workflow_dispatch' && github.actor == github.repository_owner)");
    expect(workflow).not.toMatch(/github\.event_name != /);
  });

  it("runs one at a time without cancelling a run in progress", () => {
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: factory\s*\n\s*cancel-in-progress: false/);
  });

  it("runs the tick in CI mode with a time limit inside the job's own", () => {
    const minutes = Number(workflow.match(/factory:tick -- --ci --minutes (\d+)/)?.[1]);
    const job = Number(workflow.match(/name: Factory tick[\s\S]*?timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(job).toBeGreaterThan(minutes + 15);
  });

  it("checks every repo out in the owner's folder layout", () => {
    const factory = loadFactory();
    for (const repo of Object.values(factory.repos)) {
      if (repo.path === ".") expect(workflow).toContain("path: FaultForge\n");
      else {
        expect(workflow).toContain(`repository: ${repo.github}`);
        expect(workflow).toContain(`path: ${basename(repo.path)}\n`);
      }
    }
    expect(workflow).toContain("path: FaultForge/private");
  });

  it("pushes with the owner's token, never the default bot token", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(workflow).toContain("GH_TOKEN: ${{ secrets.FACTORY_GH_TOKEN }}");
    expect(workflow).not.toMatch(/secrets\.GITHUB_TOKEN|github\.token/);
  });

  it("never prints a secret and never uploads the agent's transcript", () => {
    expect(workflow).not.toMatch(/echo[^\n]*secrets\./);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(workflow).toContain("!${{ runner.temp }}/faultforge-runs/*.agent.jsonl");
  });

  it("uses the runner context only where GitHub allows it (steps, not the job's env)", () => {
    const jobEnv = workflow.match(/name: Factory tick[\s\S]*?\n {4}env:\n([\s\S]*?)\n {4}steps:/)?.[1] ?? "";
    expect(jobEnv).not.toContain("runner.");
  });

  it("keeps no token on disk: every checkout sets persist-credentials: false, and git pushes through gh (#103)", () => {
    const steps = workflow.split(/\n {6}- /).filter((step) => step.includes("actions/checkout@"));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const step of steps) expect(step).toContain("persist-credentials: false");
    expect(workflow).toContain("gh auth setup-git");
  });

  it("gives secrets to the steps that need them, never to the whole job (#103)", () => {
    expect(workflow).not.toMatch(/name: Factory tick[\s\S]*?\n {4}env:/);
    const tick = workflow.match(/name: Run one tick[\s\S]*?run:/)?.[0] ?? "";
    for (const secret of ["FACTORY_GH_TOKEN", "QODO_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
      expect(tick).toContain(`secrets.${secret}`);
    const install = workflow.match(/name: Install dependencies[\s\S]*?run:/)?.[0] ?? "";
    expect(install).not.toContain("secrets.");
  });

  it("pins every action to a full commit", () => {
    for (const [, ref] of workflow.matchAll(/uses: [\w./-]+@(\S+)/g)) expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });
});
