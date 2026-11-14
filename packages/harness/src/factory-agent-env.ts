/**
 * The agent's environment, built from an allow-list (AUD-H2, #243). The runner's own environment holds the
 * keys it needs for its own steps: Qodo's key, and in Actions the token that can write the private repo.
 * The agent gets only what its own tools need to run: the system's paths and settings, its own run's
 * `FAULTFORGE_*` values, a GitHub token for `gh` and `git`, and the one variable Claude Code itself signs in
 * with. Anything not named here never reaches it, so a new secret added to the runner can't leak by default.
 *
 * What it needs, and why:
 *  - the system: `PATH` (and Windows' `Path`, `PATHEXT`, `SystemRoot`, `ComSpec`, ...), the home and temp
 *    folders (git reads its config from home, npm its cache), the locale and the terminal;
 *  - the run's own `FAULTFORGE_*` values, by exact name (`AGENT_RUN_VARIABLES`): the run's id, folder,
 *    ticket, the review broker, and in a target ticket's run the private checkouts its policy keeps it out of.
 *    No other `FAULTFORGE_*` passes, from the runner or the run: a prefix let a runner-side setting (a
 *    private folder, a config path) reach the agent by its name alone (AUD-H2, re-grade);
 *  - `GH_TOKEN`: `gh` and git's credential helper (`gh auth setup-git`) push and open the PR with it;
 *  - Claude Code's own sign-in: `CLAUDE_CODE_OAUTH_TOKEN` in Actions, else `ANTHROPIC_API_KEY`, only one.
 *    The CLI can't run without it. Its tools see it too: Claude Code's own setting that hides it from them
 *    (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) also forces the default permission mode in 2.1.197, which an
 *    unattended run can't answer. The policy hook refuses naming it or reading the environment whole.
 *
 * Never: `QODO_API_KEY` or `QODO_KEY_FILE` (`review:wait` asks the runner instead: factory-review-broker.ts),
 * `GH_TOKEN_FILE`, `FACTORY_GH_TOKEN`, `GITHUB_TOKEN`, or anything else.
 */

/** Exact names passed through when the runner has them. */
const SYSTEM = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "USERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "CI",
  "CLAUDE_CONFIG_DIR",
  "GH_CONFIG_DIR",
];

/**
 * The only `FAULTFORGE_*` variables the agent gets, all set by the runner for this run (`run` in `agentEnv`).
 * `FAULTFORGE_AGENT_TOKEN` is not one: it becomes `GH_TOKEN` instead.
 */
export const AGENT_RUN_VARIABLES: readonly string[] = [
  "FAULTFORGE_FACTORY_RUN",
  "FAULTFORGE_RUN_ROOT",
  "FAULTFORGE_TICKET_NUMBER",
  "FAULTFORGE_TICKET_FILE",
  "FAULTFORGE_REVIEW_BROKER",
  "FAULTFORGE_PRIVATE_CHECKOUTS",
];

/** The variables Claude Code signs in with, in the order it is given one. */
export const CLAUDE_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** What `agentEnv` decided about the GitHub token, for the run log. */
export interface AgentEnv {
  env: Record<string, string>;
  /** True when the narrower `FAULTFORGE_AGENT_TOKEN` is the agent's `GH_TOKEN`. */
  agentToken: boolean;
  /** Said once in the run log when the agent has the runner's own token. */
  warning?: string;
}

/**
 * The agent's environment, from `from` (the runner's) and the run's own values in `run`. Pure: the tests
 * call it with a made-up environment.
 */
export function agentEnv(from: Record<string, string | undefined>, run: Record<string, string>): AgentEnv {
  const env: Record<string, string> = {};
  const take = (name: string) => {
    const value = from[name];
    if (value !== undefined && value !== "") env[name] = value;
  };
  for (const name of SYSTEM) take(name);
  for (const name of Object.keys(from)) {
    if (/^LC_[A-Z]+$/.test(name)) take(name);
  }
  const auth = CLAUDE_AUTH.find((name) => from[name]);
  if (auth) take(auth);
  const agentToken = from.FAULTFORGE_AGENT_TOKEN?.trim();
  let warning: string | undefined;
  if (agentToken) env.GH_TOKEN = agentToken;
  else {
    take("GH_TOKEN");
    warning =
      "FAULTFORGE_AGENT_TOKEN is not set, so the agent has the runner's own GitHub token; give it a narrower one";
  }
  for (const [name, value] of Object.entries(run)) if (AGENT_RUN_VARIABLES.includes(name)) env[name] = value;
  return { env, agentToken: Boolean(agentToken), ...(warning ? { warning } : {}) };
}
