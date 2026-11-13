import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const realTarget = resolve(root, "../faultforge-target");
const hasRealTarget = existsSync(join(realTarget, "package.json"));

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function scratchTargetCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "inject-it-"));
  scratchDirs.push(dir);
  // node_modules is copied too: the proof test imports the target's app code, which needs its real
  // dependencies (fastify) even under --validate-only. A plain copy works on every platform and drive
  // (hard links can't cross drives on Windows, and a link would confuse `git status`); this test never
  // writes into it and removes the whole copy afterwards.
  cpSync(realTarget, dir, { recursive: true });
  return dir;
}

/** Runs the inject script the way `npm run inject` does, without npm: `tsx` by path works on every platform. */
function runInject(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(root, "packages", "harness", "src", "inject.ts");
  try {
    const stdout = execFileSync(process.execPath, [tsx, script, ...args], { cwd: root, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status: number | null; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("inject exit codes (#8: branch derivation)", () => {
  it("exits 1 for an unknown template, before any target check", () => {
    const result = runInject(["--template", "no-such-template-xyz", "--target", root, "--validate-only"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no-such-template-xyz");
  });

  // --validate-only never derives a suffix or asks origin for the branch (#8): with `origin` pointed at a
  // path that doesn't exist, any `git ls-remote` call would fail loudly, so a clean exit 0 here is itself
  // the proof that no such call was made.
  it("refuses a case id that isn't FF-NNNN before anything else (#193)", () => {
    // A trailing newline is refused too: JavaScript's `$` never matches before one (Qodo on PR 207).
    for (const bad of ["FF-12", "../x", "ff-0002", "FF-0002\n"]) {
      const result = runInject(["--template", "idempotency-guard-bypass-v1", "--target", root, "--case", bad]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FF-NNNN");
    }
  });

  it.skipIf(!hasRealTarget)(
    "refuses a detached target, and one whose HEAD isn't origin/main, without changing it (#193)",
    () => {
      const dir = scratchTargetCopy();
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
      git("switch", "-q", "main");
      const state = () => `${git("status", "--porcelain", "--branch")}|${git("rev-parse", "HEAD")}`;

      git("switch", "-q", "--detach", "HEAD");
      let before = state();
      let result = runInject(["--template", "idempotency-guard-bypass-v1", "--target", dir, "--validate-only"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("detached HEAD");
      expect(state()).toBe(before);

      git("switch", "-q", "main");
      git("switch", "-q", "-c", "earlier-case-branch");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Earlier change",
      );
      // A real run, so nothing may reach the owner's private storage or the network, whatever the code does.
      git("remote", "set-url", "origin", "/nonexistent/origin.git");
      const savedPrivate = process.env.FAULTFORGE_PRIVATE_DIR;
      process.env.FAULTFORGE_PRIVATE_DIR = mkdtempSync(join(tmpdir(), "inject-private-"));
      scratchDirs.push(process.env.FAULTFORGE_PRIVATE_DIR);
      try {
        before = state();
        result = runInject(["--template", "idempotency-guard-bypass-v1", "--target", dir, "--case", "FF-9999"]);
      } finally {
        if (savedPrivate === undefined) delete process.env.FAULTFORGE_PRIVATE_DIR;
        else process.env.FAULTFORGE_PRIVATE_DIR = savedPrivate;
      }
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is not origin/main");
      expect(state()).toBe(before);
    },
    90_000,
  );

  it.skipIf(!hasRealTarget)(
    "--validate-only exits 0 without ever asking origin about the branch",
    () => {
      const dir = scratchTargetCopy();
      execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "/nonexistent/origin.git"]);
      // The owner's checkout may still hold the first case's branch; the copy must not inherit it.
      try {
        execFileSync("git", ["-C", dir, "branch", "-D", "tidy-replay-lookup"], { stdio: "ignore" });
      } catch {
        // absent in a fresh clone, such as CI: nothing to drop
      }

      // Whatever branch and state the copy starts in (it mirrors the owner's checkout), it must end the same.
      const gitStatus = () =>
        execFileSync("git", ["-C", dir, "status", "--porcelain", "--branch"], { encoding: "utf8" });
      const before = gitStatus();
      const result = runInject(["--template", "idempotency-guard-bypass-v1", "--target", dir, "--validate-only"]);
      expect(result.status).toBe(0);
      expect(gitStatus()).toBe(before);
    },
    90_000,
  );
});
