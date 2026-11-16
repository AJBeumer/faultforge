/**
 * Test fixtures for the hooks: temporary git repositories that stand in for a reviewed checkout, a
 * factory.json that points the guard at them, and the guard's decision asked in-process. No test ever
 * reads or changes the owner's real checkouts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide as policyDecide } from "./factory-policy.ts";
import { decide } from "./guard-target.ts";

/** This repository's factory.json, parsed once; the guard tests change copies of it. */
export const FACTORY = JSON.parse(readFileSync(join(import.meta.dirname, "../../factory.json"), "utf8"));

/**
 * factory.json with the target's checkout pointed at `checkout` (a fixture repo, or a folder that doesn't
 * exist), changed further by `extra`, and written to its own temp file. The guard reads the file named by
 * FAULTFORGE_CONFIG, so no decision in the tests reads the owner's real checkouts.
 */
export function guardConfig(checkout: string, extra?: (config: typeof FACTORY) => void): string {
  const config = structuredClone(FACTORY);
  config.repos.target.path = checkout;
  extra?.(config);
  const file = join(mkdtempSync(join(tmpdir(), "guard-config-")), "factory.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/**
 * The guard's decision for one tool call, asked in-process with `config` as its factory.json: the deny
 * reason, or undefined when allowed. A blocking error throws and fails the test; the process tests in
 * guard-target.test.ts cover how an error is reported.
 */
export function guardDecision(tool: string, toolInput: object, cwd: string, config: string): string | undefined {
  return askGuard(tool, toolInput, cwd, { config });
}

/** How a test asks the guard: its factory.json, its private storage, and whether to clear a factory run first. */
export interface Asking {
  config: string;
  privateDir?: string;
  outsideRun?: boolean;
}

/**
 * The guard's deny reason for one tool call asked in-process, or undefined when allowed; a blocking error throws.
 * `extra` is added to the environment last, so it can start a factory run or point at other private storage.
 */
export function askGuard(
  tool: string,
  toolInput: object,
  cwd: string,
  how: Asking,
  extra: NodeJS.ProcessEnv = {},
): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, FAULTFORGE_CONFIG: how.config };
  if (how.privateDir !== undefined) env.FAULTFORGE_PRIVATE_DIR = how.privateDir;
  if (how.outsideRun) delete env.FAULTFORGE_FACTORY_RUN;
  Object.assign(env, extra);
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: toolInput }), env);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

/**
 * Private storage in its own temp folder named from `prefix`, holding the unreleased template `x-secret-v1` and
 * any `more`. A `~` in the prefix gives the folder a name like a Windows short name (CI runs in `RUNNER~1`).
 */
export function privateStore(prefix: string, more: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const id of ["x-secret-v1", ...more]) mkdirSync(join(dir, "templates", id), { recursive: true });
  return dir;
}

/** A temp folder that is no checkout, named from `prefix`, holding `files` (name to text). */
export function scratchFolder(prefix: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** The owner's three repos on GitHub, as the guard tests name them. */
export const REPOS = {
  target: "AJBeumer/faultforge-target",
  lab: "AJBeumer/faultforge",
  private: "AJBeumer/faultforge-private",
};

/** The deny reason of the door rule: every write to a reviewed repo goes through npm run target:post. */
export const DOOR = /go only through the door/;

/**
 * A lab checkout with the private checkout inside it as `private/`, as the owner keeps them: the lab has a `lab`
 * remote; the private checkout has its own `origin` and a `lab` remote, and holds the template `x-secret-v1`.
 */
export function labWithPrivate(): { lab: TempRepo; privateDir: string } {
  const lab = tempRepo(true);
  lab.git("remote", "add", "lab", `https://github.com/${REPOS.lab}.git`);
  const privateDir = join(lab.dir, "private");
  mkdirSync(join(privateDir, "templates", "x-secret-v1"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", privateDir]);
  execFileSync("git", ["-C", privateDir, "remote", "add", "origin", `https://github.com/${REPOS.private}.git`]);
  execFileSync("git", ["-C", privateDir, "remote", "add", "lab", `https://github.com/${REPOS.lab}.git`]);
  return { lab, privateDir };
}

/**
 * A factory run's folder under the temp folder, with the lab inside it (made on disk when `makeLab`), the
 * environment the runner gives the agent, and the policy hook's deny reason for one tool call asked in-process.
 */
export function policyRun(prefix: string, makeLab = false) {
  const RUN = mkdtempSync(join(tmpdir(), prefix));
  const LAB = join(RUN, "faultforge");
  if (makeLab) mkdirSync(LAB, { recursive: true });
  const ENV: NodeJS.ProcessEnv = {
    FAULTFORGE_FACTORY_RUN: "1",
    FAULTFORGE_RUN_ROOT: RUN,
    FAULTFORGE_TICKET_NUMBER: "999",
  };
  const policy = (tool: string, input: object, cwd = LAB): string | undefined => {
    const decision = policyDecide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), ENV);
    if (decision.kind === "error") throw new Error(decision.message);
    return decision.kind === "deny" ? decision.reason : undefined;
  };
  return { RUN, LAB, ENV, policy };
}

export interface TempRepo {
  /** The working tree. */
  dir: string;
  /** Runs git in it with a fixed identity and returns stdout. */
  git: (...args: string[]) => string;
}

/**
 * A temporary git repository with one commit. With `withOrigin`, a bare `origin` tracks its `main`; without
 * one, every local commit counts as unpushed, which tests that don't push don't mind.
 */
export function tempRepo(withOrigin = false): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "guard-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# App\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  if (withOrigin) {
    const remote = mkdtempSync(join(tmpdir(), "guard-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
  }
  return { dir, git };
}

/** True when this machine can create symlinks (Windows needs Developer Mode or elevation). */
export function canSymlink(): boolean {
  try {
    const dir = mkdtempSync(join(tmpdir(), "guard-ln-"));
    symlinkSync("target", join(dir, "link"));
    return true;
  } catch {
    return false;
  }
}

/**
 * How much slower `run` gets when its input grows `factor` times: the best of several timed runs at each size,
 * after a warm-up, so a busy machine slows both sizes alike and a pause in one run doesn't count. Linear code
 * grows at most `factor` times (less, with fixed costs such as a git call); quadratic code about factor² times.
 * So a bound between them (`LINEAR_BOUND`) holds on a slow machine as on a fast one, and fails when the code
 * turns quadratic. There is no wall-clock limit: on a loaded machine one would fail at random.
 */
export function growth(run: (scale: number) => void, factor = GROWTH_FACTOR): number {
  const best = (scale: number, times: number) => {
    let least = Number.POSITIVE_INFINITY;
    for (let i = 0; i < times; i++) {
      const started = performance.now();
      run(scale);
      least = Math.min(least, performance.now() - started);
    }
    return least;
  };
  run(1);
  run(factor);
  // A floor of a twentieth of a millisecond, under which the timer can't tell sizes apart.
  return best(factor, 3) / Math.max(best(1, 5), 0.05);
}

/** The input growth `growth` measures by default: eight times. */
export const GROWTH_FACTOR = 8;
/** Three times what linear code can reach at GROWTH_FACTOR (8), and well under quadratic code's 64. */
export const LINEAR_BOUND = 24;
