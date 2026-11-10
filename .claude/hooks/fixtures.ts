/**
 * Test fixtures for the hooks: temporary git repositories that stand in for a reviewed checkout, a
 * factory.json that points the guard at them, and the guard's decision asked in-process. No test ever
 * reads or changes the owner's real checkouts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const payload = JSON.stringify({ tool_name: tool, cwd, tool_input: toolInput });
  const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: config });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
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
