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
  // node_modules is hard-linked rather than copied: the proof test imports the target's app code, which
  // needs its real dependencies (fastify) even under --validate-only, and `.gitignore`'s `node_modules/`
  // only matches a real directory, not a symlink. `cp -al` makes one (so `git status` reads it the same
  // way as the real checkout's) without duplicating the data; this test never writes into it.
  cpSync(realTarget, dir, { recursive: true, filter: (src) => !src.includes(`${realTarget}/node_modules`) });
  execFileSync("cp", ["-al", join(realTarget, "node_modules"), join(dir, "node_modules")]);
  return dir;
}

function runInject(args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npm", ["run", "--silent", "inject", "--", ...args], { cwd: root, encoding: "utf8" });
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
  it.skipIf(!hasRealTarget)("--validate-only exits 0 without ever asking origin about the branch", () => {
    const dir = scratchTargetCopy();
    execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "/nonexistent/origin.git"]);
    const result = runInject(["--template", "idempotency-guard-bypass-v1", "--target", dir, "--validate-only"]);
    expect(result.status).toBe(0);
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain", "--branch"], { encoding: "utf8" });
    expect(status.trim()).toBe("## main...origin/main");
  });
});
