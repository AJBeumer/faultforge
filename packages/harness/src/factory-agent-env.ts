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
 *  - `FAULTFORGE_*`: the run's id, folder, ticket and the review broker, which its hooks and tools read;
 *    except `FAULTFORGE_AGENT_TOKEN`, which becomes `GH_TOKEN` instead;
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
    if (name.startsWith("FAULTFORGE_") && name !== "FAULTFORGE_AGENT_TOKEN") take(name);
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
  return { env: { ...env, ...run }, agentToken: Boolean(agentToken), ...(warning ? { warning } : {}) };
}
