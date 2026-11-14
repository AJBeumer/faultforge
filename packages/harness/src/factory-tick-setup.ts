/**
 * What `npm run factory:tick` checks before any tick runs (`factory-tick.ts`'s `main`): its options, the
 * GitHub token, and whether this machine may run one at all. Each failure is the command line or the
 * environment being wrong, exit 2, never a failed run.
 *
 * Exit codes: 2 from `positiveOption`, for an option that isn't a positive number, the command line being
 * wrong (`factory-tick.ts`'s 2). Nothing else here exits; the others return a problem for `main` to report.
 */
import { readFileSync } from "node:fs";
import type { TickDeps } from "./factory-tick-deps.ts";

/** `--minutes` and `--budget`, each a positive number, falling back to the given default; exits 2
 * naming whichever one isn't. */
export function positiveOption(values: Record<string, unknown>, name: "minutes" | "budget", fallback: number): number {
  const value = values[name] === undefined ? fallback : Number(values[name]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(
      `usage: npm run factory:tick -- [--ci] [--minutes N] [--budget USD]   (--${name} must be a positive number)`,
    );
    process.exit(2);
  }
  return value;
}

/**
 * GH_TOKEN, or the content of the file GH_TOKEN_FILE names, or why neither can be had. A token file that is
 * missing or empty is the environment being wrong (exit 2), never a crash that reads as a failed run.
 */
export function tokenFrom(
  env: Record<string, string | undefined>,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { token: string } | { problem: string } {
  if (env.GH_TOKEN) return { token: env.GH_TOKEN };
  if (!env.GH_TOKEN_FILE) return { problem: "factory:tick needs GH_TOKEN or GH_TOKEN_FILE." };
  try {
    const token = read(env.GH_TOKEN_FILE).trim();
    return token ? { token } : { problem: "factory:tick: the file GH_TOKEN_FILE names is empty." };
  } catch (error) {
    return { problem: `factory:tick can't read GH_TOKEN_FILE (${(error as NodeJS.ErrnoException).code ?? "error"}).` };
  }
}

/** Why no tick may run on this machine as it is (exit 2), or null. Read through the deps, so it is tested. */
export function setupRefusal(deps: Pick<TickDeps, "unguarded">): string | null {
  const unguarded = deps.unguarded?.() ?? [];
  return unguarded.length ? `factory:tick refused: ${unguarded.join("; ")}. Run npm run guard:install first.` : null;
}
