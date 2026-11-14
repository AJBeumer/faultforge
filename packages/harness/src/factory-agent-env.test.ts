import { describe, expect, it } from "vitest";
import { agentEnv } from "./factory-agent-env.ts";

/** A runner's environment as Actions or the owner's PC has it: made-up values throughout. */
const RUNNER = {
  PATH: "/usr/bin",
  HOME: "/home/runner",
  TEMP: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  GH_TOKEN: "runner-token-1234",
  GH_TOKEN_FILE: "/secret/gh.txt",
  FACTORY_GH_TOKEN: "factory-token-1234",
  GITHUB_TOKEN: "actions-token-1234",
  QODO_API_KEY: "qodo-key-1234",
  QODO_KEY_FILE: "/secret/qodo.txt",
  CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-1234",
  ANTHROPIC_API_KEY: "anthropic-key-1234",
  ACTIONS_RUNTIME_TOKEN: "runtime-1234",
  SOME_NEW_SECRET: "nobody-listed-me",
  FAULTFORGE_RUNS_DIR: "/runs",
};
const RUN = { FAULTFORGE_FACTORY_RUN: "r1", FAULTFORGE_RUN_ROOT: "/runs/r1" };

describe("agentEnv: the agent gets an allow-list, not the runner's environment (AUD-H2, #243)", () => {
  it("keeps the system's paths, locale, home and temp folders, and the run's own values", () => {
    const { env } = agentEnv(RUNNER, RUN);
    for (const name of ["PATH", "HOME", "TEMP", "LANG", "LC_ALL", "FAULTFORGE_RUNS_DIR", "FAULTFORGE_FACTORY_RUN"])
      expect(env[name]).toBeDefined();
    expect(env.FAULTFORGE_RUN_ROOT).toBe("/runs/r1");
  });

  it("leaves out the Qodo key and key file, the token files, the factory's and Actions' own tokens, and anything unlisted", () => {
    const { env } = agentEnv(RUNNER, RUN);
    for (const name of [
      "QODO_API_KEY",
      "QODO_KEY_FILE",
      "GH_TOKEN_FILE",
      "FACTORY_GH_TOKEN",
      "GITHUB_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
      "SOME_NEW_SECRET",
    ])
      expect(env).not.toHaveProperty(name);
    expect(Object.values(env)).not.toContain("qodo-key-1234");
  });

  it("passes exactly one of the variables Claude Code signs in with, the one it needs to start", () => {
    const both = agentEnv(RUNNER, RUN).env;
    expect(both.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-1234");
    expect(both).not.toHaveProperty("ANTHROPIC_API_KEY");
    const keyOnly = agentEnv({ ...RUNNER, CLAUDE_CODE_OAUTH_TOKEN: undefined }, RUN).env;
    expect(keyOnly.ANTHROPIC_API_KEY).toBe("anthropic-key-1234");
    expect(keyOnly).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    // On the owner's PC Claude Code signs in from its own files in the home folder: no variable at all.
    const none = agentEnv({ PATH: "/usr/bin", HOME: "/h" }, RUN).env;
    expect(Object.keys(none).filter((n) => /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(n))).toEqual([]);
  });

  it("gives the agent FAULTFORGE_AGENT_TOKEN as its GH_TOKEN when set, never the runner's", () => {
    const result = agentEnv({ ...RUNNER, FAULTFORGE_AGENT_TOKEN: "narrow-token-1234" }, RUN);
    expect(result.env.GH_TOKEN).toBe("narrow-token-1234");
    expect(result.env).not.toHaveProperty("FAULTFORGE_AGENT_TOKEN");
    expect(Object.values(result.env)).not.toContain("runner-token-1234");
    expect(result.agentToken).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("without FAULTFORGE_AGENT_TOKEN keeps the runner's GH_TOKEN, as before, and says so", () => {
    const result = agentEnv(RUNNER, RUN);
    expect(result.env.GH_TOKEN).toBe("runner-token-1234");
    expect(result.agentToken).toBe(false);
    expect(result.warning).toMatch(/FAULTFORGE_AGENT_TOKEN is not set/);
  });

  it("the run's own values win over the runner's", () => {
    const { env } = agentEnv({ ...RUNNER, FAULTFORGE_FACTORY_RUN: "old" }, RUN);
    expect(env.FAULTFORGE_FACTORY_RUN).toBe("r1");
  });
});
