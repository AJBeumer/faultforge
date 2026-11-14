/**
 * The factory workflow's safety properties, read from the file itself so a later edit can't drop one
 * quietly. Plain text checks: the workflow is small and these lines are its contract.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimMarker } from "./factory-comments.ts";
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

  it("runs one tick at a time without cancelling one in progress, queued on the job, not the workflow (audit N-5)", () => {
    const top = workflow.slice(0, workflow.indexOf("\njobs:"));
    expect(top).not.toMatch(/^concurrency:/m);
    const tick = workflow.slice(workflow.indexOf("name: Factory tick"));
    expect(tick).toMatch(/\n {4}concurrency:\s*\n\s*group: factory-tick\s*\n\s*cancel-in-progress: false/);
  });

  it("runs the tick in CI mode with a time limit inside the job's own", () => {
    const minutes = Number(workflow.match(/factory:tick -- --ci --minutes (\d+)/)?.[1]);
    const job = Number(workflow.match(/name: Factory tick[\s\S]*?timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(job).toBeGreaterThanOrEqual(minutes + 45);
  });

  it("starts a tick when a ticket is left agent-working, so an interrupted run is recovered (#197)", () => {
    expect(workflow).toMatch(/for label in ready-for-agent agent-working; do/);
  });

  it("doesn't count a ticket a run on the owner's PC claimed and that shows no result yet (Qodo on PR 268)", () => {
    // The look job reads the same mark the claim comment carries.
    expect(claimMarker("local")).toBe("<!-- scheduled-run claim mode=local -->");
    expect(workflow).toContain('capture(\\"<!-- scheduled-run claim mode=(?<m>ci|local) -->\\").m');
    expect(workflow).toMatch(/if \[ "\$mode" = local \]; then[\s\S]*?continue/);
    expect(workflow).toContain('select(. == "agent-done" or . == "agent-needs-help")');
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

  it("keeps a cancelled or crashed run's transcript: an always() step after the tick pushes it to private storage (AUD-M19)", () => {
    const steps = workflow.split(/\n {6}- /);
    const tick = steps.findIndex((step) => step.startsWith("name: Run one tick"));
    const keep = steps.findIndex((step) => step.includes("npm run -s factory:keep"));
    expect(tick).toBeGreaterThan(0);
    expect(keep).toBeGreaterThan(tick);
    expect(steps[keep]).toMatch(/\n {8}if: always\(\)\n/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(steps[keep]).toContain("FAULTFORGE_RUNS_DIR: ${{ runner.temp }}/faultforge-runs");
    // The public artifact still never holds a transcript.
    const artifact = steps.find((step) => step.includes("actions/upload-artifact@")) ?? "";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(artifact).toContain("!${{ runner.temp }}/faultforge-runs/*.agent.jsonl");
  });

  it("stops the tick step before the job's own limit, so the keep step still runs, on a branch per attempt (Qodo on PR 268)", () => {
    const steps = workflow.split(/\n {6}- /);
    const tick = steps.find((step) => step.startsWith("name: Run one tick")) ?? "";
    const stepLimit = Number(tick.match(/\n {8}timeout-minutes: (\d+)/)?.[1]);
    const jobLimit = Number(workflow.match(/name: Factory tick[\s\S]*?timeout-minutes: (\d+)/)?.[1]);
    const agentLimit = Number(workflow.match(/factory:tick -- --ci --minutes (\d+)/)?.[1]);
    expect(stepLimit).toBeGreaterThan(agentLimit);
    expect(jobLimit - stepLimit).toBeGreaterThanOrEqual(5);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions, not a JS template
    expect(workflow).toContain("--branch unsaved-${{ github.run_id }}-${{ github.run_attempt }}");
  });

  it("installs the git-level guard before the agent can commit, after the dependencies (AUD-M17)", () => {
    const steps = workflow.split(/\n {6}- /);
    const install = steps.findIndex((step) => step.includes("npm run -s guard:install"));
    const deps = steps.findIndex((step) => step.startsWith("name: Install dependencies"));
    const tick = steps.findIndex((step) => step.startsWith("name: Run one tick"));
    expect(install).toBeGreaterThan(deps);
    expect(install).toBeLessThan(tick);
    expect(steps[install]).toContain("working-directory: FaultForge");
    expect(steps[install]).not.toMatch(/if:|continue-on-error/);
  });

  it("gives the tick the agent's own narrower token, which the agent gets as GH_TOKEN (AUD-H2)", () => {
    const tick = workflow.match(/name: Run one tick[\s\S]*?run:/)?.[0] ?? "";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(tick).toContain("FAULTFORGE_AGENT_TOKEN: ${{ secrets.FACTORY_AGENT_TOKEN }}");
  });

  it("pins every action to a full commit", () => {
    for (const [, ref] of workflow.matchAll(/uses: [\w./-]+@(\S+)/g)) expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });
});
