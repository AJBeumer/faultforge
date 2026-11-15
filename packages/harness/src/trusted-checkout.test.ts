import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTrustedCheckout, removeTrustedCheckout } from "./trusted-checkout.ts";

describe("buildTrustedCheckout: revert:check runs from a fresh checkout of main, never the agent's worktree (#161)", () => {
  let root: string;
  const sh = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** `origin` is a bare repo whose `main` holds the real script and a trivial, dependency-free
   * `package.json`/lockfile (so the trusted checkout's own `npm ci` needs no network). `sourceRepo`,
   * cloned from it, then has its own working tree switched to a branch with a doctored copy of the
   * script, and its own `origin` remote pointed somewhere that was never pushed to - standing in for
   * the agent's worktree with an edit to `revert-check.ts` itself, committed but never merged, and a
   * tampered remote config, neither of which would ever show up in a tracked file's diff. */
  function sourceWithDoctoredWorktree() {
    root = mkdtempSync(join(tmpdir(), "trusted-checkout-test-"));
    const origin = join(root, "origin.git");
    const unrelated = join(root, "unrelated.git");
    const sourceRepo = join(root, "source");
    sh(root, "init", "-q", "--bare", origin);
    sh(root, "init", "-q", "--bare", unrelated);
    sh(root, "clone", "-q", origin, sourceRepo);
    sh(sourceRepo, "config", "user.email", "t@example.com");
    sh(sourceRepo, "config", "user.name", "t");
    writeFileSync(join(sourceRepo, "script.ts"), "export const verdict = () => 'real';\n");
    writeFileSync(join(sourceRepo, "package.json"), '{"name":"lab","version":"1.0.0"}\n');
    writeFileSync(
      join(sourceRepo, "package-lock.json"),
      '{"name":"lab","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"lab","version":"1.0.0"}}}\n',
    );
    sh(sourceRepo, "add", "script.ts", "package.json", "package-lock.json");
    sh(sourceRepo, "commit", "-qm", "base");
    sh(sourceRepo, "push", "-q", "origin", "HEAD:main");
    sh(sourceRepo, "checkout", "-qb", "doctor-it");
    writeFileSync(join(sourceRepo, "script.ts"), "export const verdict = () => 'forged pass';\n");
    sh(sourceRepo, "add", "script.ts");
    sh(sourceRepo, "commit", "-qm", "always pass");
    sh(sourceRepo, "remote", "set-url", "origin", unrelated);
    return { sourceRepo, origin };
  }

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("checks out main by its real address, untouched by a doctored branch or remote in the agent's own worktree", () => {
    const { sourceRepo, origin } = sourceWithDoctoredWorktree();
    const verifyRoot = join(root, "verify");
    // `origin` here is the trusted address `buildTrustedCheckout` is given (what `factory.json` would
    // resolve to), not `sourceRepo`'s own (tampered) `origin` remote.
    const lab = buildTrustedCheckout(verifyRoot, "lab", origin);
    expect(readFileSync(join(lab, "script.ts"), "utf8")).toContain("'real'");
    // The agent's own worktree is left exactly as it was: still on its branch, still doctored.
    expect(sh(sourceRepo, "branch", "--show-current")).toBe("doctor-it");
    expect(readFileSync(join(sourceRepo, "script.ts"), "utf8")).toContain("forged pass");
    // A real "origin" of its own, so revert-check.ts's own fetch-by-name logic still works.
    expect(sh(lab, "remote", "get-url", "origin")).toBe(origin);
    expect(removeTrustedCheckout(verifyRoot)).toBeNull();
    expect(existsSync(verifyRoot)).toBe(false);
  });

  it("ignores a url.insteadOf rule in the source checkout's own local git config", () => {
    const { sourceRepo, origin } = sourceWithDoctoredWorktree();
    // A rule that would silently rewrite the trusted address itself, if this checkout inherited
    // sourceRepo's config the way a worktree of it would.
    sh(sourceRepo, "config", `url.${join(root, "unrelated.git")}.insteadOf`, origin);
    const verifyRoot = join(root, "verify");
    const lab = buildTrustedCheckout(verifyRoot, "lab", origin);
    expect(readFileSync(join(lab, "script.ts"), "utf8")).toContain("'real'");
    removeTrustedCheckout(verifyRoot);
  });

  it("clones a sibling repo fresh at the path the checked-out script resolves it at, never linking the agent's checkout (#335)", () => {
    const { origin } = sourceWithDoctoredWorktree();
    // The sibling's real address, and the agent's checkout of it, whose .git it could write (a hook, a filter).
    const siblingOrigin = join(root, "sibling.git");
    const agentCheckout = join(root, "a-sibling-repo");
    sh(root, "init", "-q", "--bare", siblingOrigin);
    sh(root, "clone", "-q", siblingOrigin, agentCheckout);
    sh(agentCheckout, "config", "user.email", "t@example.com");
    sh(agentCheckout, "config", "user.name", "t");
    writeFileSync(join(agentCheckout, "marker.txt"), "sibling\n");
    writeFileSync(join(agentCheckout, "package.json"), '{"name":"t","version":"1.0.0"}\n');
    writeFileSync(
      join(agentCheckout, "package-lock.json"),
      '{"name":"t","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"t","version":"1.0.0"}}}\n',
    );
    sh(agentCheckout, "add", ".");
    sh(agentCheckout, "commit", "-qm", "base");
    sh(agentCheckout, "push", "-q", "origin", "HEAD:main");
    sh(agentCheckout, "config", "core.fsmonitor", "./evil.sh");
    mkdirSync(join(agentCheckout, ".git", "hooks"), { recursive: true });
    writeFileSync(join(agentCheckout, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho evil\n");
    const verifyRoot = join(root, "verify");
    buildTrustedCheckout(verifyRoot, "lab", origin, { remoteUrl: siblingOrigin, path: "../a-sibling-repo" });
    const sibling = join(verifyRoot, "a-sibling-repo");
    expect(readFileSync(join(sibling, "marker.txt"), "utf8")).toBe("sibling\n");
    expect(lstatSync(sibling).isSymbolicLink()).toBe(false);
    expect(existsSync(join(sibling, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(readFileSync(join(sibling, ".git", "config"), "utf8")).not.toContain("fsmonitor");
    expect(sh(sibling, "remote", "get-url", "origin")).toBe(siblingOrigin);
    removeTrustedCheckout(verifyRoot);
  });

  it("throws a clear message, and removes anything already made, when the address can't be reached", () => {
    root = mkdtempSync(join(tmpdir(), "trusted-checkout-test-"));
    const verifyRoot = join(root, "verify");
    expect(() => buildTrustedCheckout(verifyRoot, "lab", join(root, "nowhere.git"))).toThrow(
      /couldn't build a clean checkout of main/,
    );
    expect(existsSync(verifyRoot)).toBe(false);
  });
});

describe("removeTrustedCheckout: reports what it couldn't remove, rather than throwing (#161)", () => {
  it("names the folder it couldn't clear, for a path no filesystem call can resolve", () => {
    expect(removeTrustedCheckout("\0not-a-real-path")).toMatch(/couldn't remove the trusted checkout/);
  });
});
