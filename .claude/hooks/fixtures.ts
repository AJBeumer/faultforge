/**
 * Test fixtures for the hooks: temporary git repositories that stand in for a reviewed checkout, so no
 * test ever reads or changes the owner's real checkouts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
