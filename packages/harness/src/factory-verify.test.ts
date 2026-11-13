import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import { npm as realNpm } from "./factory-exec.ts";
import type { Workspace } from "./factory-tick.ts";
import { commitToVerify, prViewProblems, readJsonRecord, type VerifyPrIo, verifyPrWith } from "./factory-verify.ts";

describe("readJsonRecord: never throws on a missing or damaged file (#161)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a well-formed record", () => {
    dir = mkdtempSync(join(tmpdir(), "json-record-"));
    const file = join(dir, "record.json");
    writeFileSync(file, '{"exit":0}');
    expect(readJsonRecord(file)).toEqual({ exit: 0 });
  });

  it("is null for a file that was never written", () => {
    dir = mkdtempSync(join(tmpdir(), "json-record-"));
    expect(readJsonRecord(join(dir, "missing.json"))).toBeNull();
  });

  it("is null, not thrown, for a record cut off mid-write", () => {
    dir = mkdtempSync(join(tmpdir(), "json-record-"));
    const file = join(dir, "record.json");
    writeFileSync(file, '{"exit":0, "message": "trunc');
    expect(readJsonRecord(file)).toBeNull();
  });
});

describe("verifyPrWith: review:wait runs from the trusted checkout, never the agent's worktree (#170)", () => {
  let root: string;
  const sh = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const EVIDENCE = "evidence";

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A tiny stand-in for `review-wait.ts`, run by real `npm run -s review:wait -- <repoKey> <pr>
   * --commit <sha> --timeout <n>` (the same command `verifyPrWith` runs), so the test proves real
   * `npm` script resolution picks whichever checkout it runs from, not a hand-written fake of it.
   * Writes `openFindings` as given, under the same path `verifyPrWith` itself reads back. */
  function reviewWaitStub(openFindings: unknown[]): string {
    return `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [repoKey, pr, , commit] = process.argv.slice(2);
const dir = join(process.cwd(), 'evidence', 'reviews', \`\${repoKey}-pr\${pr}\`);
mkdirSync(dir, { recursive: true });
const openFindings = ${JSON.stringify(openFindings)};
writeFileSync(join(dir, \`\${commit.slice(0, 7)}.review.json\`), JSON.stringify({ openFindings }));
`;
  }

  // The real revert-check.ts finds the PR's own head itself; this stub isn't under test here (#161
  // already proved its own checkout), so the test's npm wrapper hands it the commit over the
  // environment instead, just to name the record file `verifyPrWith` goes looking for.
  const REVERT_CHECK_STUB = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [repoKey, pr] = process.argv.slice(2);
const dir = join(process.cwd(), 'evidence', 'revert-checks', \`\${repoKey}-pr\${pr}\`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, \`\${process.env.FAKE_SHORT}.revert-check.json\`), JSON.stringify({ exit: 0 }));
`;

  /**
   * `origin`'s main holds the genuine `review-wait-stub.mjs`, which reports one real, unresolved
   * finding. `sourceRepo` (standing in for the agent's worktree, `ws.lab`) is cloned from it, then has
   * a branch where that very script is edited to always report a clean review instead - a committed,
   * never-pushed edit to `review-wait.ts` itself, exactly what an agent's own pull request branch can
   * hold without that edit ever reaching `main`.
   */
  function sourceWithForgedStub() {
    root = mkdtempSync(join(tmpdir(), "verify-pr-with-test-"));
    const origin = join(root, "origin.git");
    const sourceRepo = join(root, "source");
    sh(root, "init", "-q", "--bare", origin);
    sh(root, "clone", "-q", origin, sourceRepo);
    sh(sourceRepo, "config", "user.email", "t@example.com");
    sh(sourceRepo, "config", "user.name", "t");
    writeFileSync(
      join(sourceRepo, "review-wait-stub.mjs"),
      reviewWaitStub([{ severity: "action_required", title: "a real finding Qodo raised" }]),
    );
    writeFileSync(join(sourceRepo, "revert-check-stub.mjs"), REVERT_CHECK_STUB);
    writeFileSync(
      join(sourceRepo, "package.json"),
      JSON.stringify({
        name: "lab",
        version: "1.0.0",
        scripts: { "review:wait": "node review-wait-stub.mjs", "revert:check": "node revert-check-stub.mjs" },
      }),
    );
    writeFileSync(
      join(sourceRepo, "package-lock.json"),
      '{"name":"lab","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"lab","version":"1.0.0"}}}\n',
    );
    sh(sourceRepo, "add", "review-wait-stub.mjs", "revert-check-stub.mjs", "package.json", "package-lock.json");
    sh(sourceRepo, "commit", "-qm", "base");
    sh(sourceRepo, "push", "-q", "origin", "HEAD:main");
    sh(sourceRepo, "checkout", "-qb", "pr-branch");
    writeFileSync(join(sourceRepo, "review-wait-stub.mjs"), reviewWaitStub([]));
    sh(sourceRepo, "add", "review-wait-stub.mjs");
    sh(sourceRepo, "commit", "-qm", "always pass");
    const pushed = sh(sourceRepo, "rev-parse", "--verify", "refs/heads/pr-branch");
    return { sourceRepo, origin, pushed };
  }

  it("settles the verdict from the real checkout's script, never the doctored worktree's", () => {
    const { sourceRepo, origin, pushed } = sourceWithForgedStub();
    const short = pushed.slice(0, 7);
    const factory: FactoryConfig = {
      evidence: EVIDENCE,
      repos: {
        lab: {
          github: "example/lab",
          path: ".",
          guard: "lab",
          check: "npm run check",
          tests: "\\.test\\.ts$",
          start: null,
          tickets: { sections: ["Result"], checklist: "Result" },
          board: true,
        },
      },
    };
    const ws: Workspace = {
      root: join(root, "run-7"),
      lab: sourceRepo,
      private: join(root, "private"),
      mainAtStart: {},
      fingerprints: {},
    };
    const calls: { cwd: string; args: string[] }[] = [];
    // The real npm, exactly as `realDeps()`'s own `npm` wrapper calls it: whatever script runs is
    // whatever `package.json` at `cwd` resolves, not a behavior this test hand-picks.
    const npm: VerifyPrIo["npm"] = (cwd, args, timeoutMs) => {
      calls.push({ cwd, args: [...args] });
      const env = args.includes("revert:check") ? { ...process.env, FAKE_SHORT: short } : undefined;
      return realNpm(cwd, args, timeoutMs, env);
    };
    const ghJson: VerifyPrIo["ghJson"] = ((...args: string[]) => {
      if (args.includes("headRefOid,headRefName")) return { headRefOid: pushed, headRefName: "pr-branch" };
      return {
        state: "OPEN",
        headRefOid: pushed,
        statusCheckRollup: [{ name: "check", conclusion: "SUCCESS" }],
      };
    }) as VerifyPrIo["ghJson"];
    const git: VerifyPrIo["git"] = (cwd, ...args) => sh(cwd, ...args);

    const verifyRoot = join(root, "runs");
    const result = verifyPrWith({ ghJson, git, npm }, factory, verifyRoot, () => origin, ws, "lab", 42);

    // The real finding from main's genuine script survived, even though ws.lab's own copy of the
    // script was edited to always report a clean review.
    expect(result.problems).toEqual(["1 action-required finding(s) still open: a real finding Qodo raised"]);
    const reviewCall = calls.find((c) => c.args.includes("review:wait"));
    expect(reviewCall?.cwd).not.toBe(sourceRepo);
    // The evidence review:wait wrote in the (now-removed) trusted checkout reached the permanent,
    // agent-worktree evidence path `saveEvidence` carries to the private repo - the genuine finding,
    // not the forged "clean" one the doctored worktree's own script would have written.
    const permanent = JSON.parse(
      readFileSync(join(sourceRepo, EVIDENCE, "reviews", "lab-pr42", `${short}.review.json`), "utf8"),
    );
    expect(permanent.openFindings).toEqual([{ severity: "action_required", title: "a real finding Qodo raised" }]);
    // The trusted checkout is gone once verification finishes, so nothing of it lingers to inspect
    // or tamper with afterwards.
    expect(existsSync(verifyRoot)).toBe(true);
    expect(readdirSync(verifyRoot)).toHaveLength(0);
  });

  it("keeps review:wait's evidence even when the review doesn't complete", () => {
    // A timed-out or skipped review still writes what it saw (here, a lone head-wait record) before
    // its non-zero exit; that's worth keeping even though the PR doesn't count as verified, and the
    // trusted checkout holding it is removed as soon as this call returns (Qodo on PR 171).
    root = mkdtempSync(join(tmpdir(), "verify-pr-with-test-"));
    const origin = join(root, "origin.git");
    const sourceRepo = join(root, "source");
    sh(root, "init", "-q", "--bare", origin);
    sh(root, "clone", "-q", origin, sourceRepo);
    sh(sourceRepo, "config", "user.email", "t@example.com");
    sh(sourceRepo, "config", "user.name", "t");
    sh(sourceRepo, "checkout", "-qB", "main");
    writeFileSync(
      join(sourceRepo, "review-wait-stub.mjs"),
      `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [repoKey, pr, , commit] = process.argv.slice(2);
const dir = join(process.cwd(), 'evidence', 'reviews', \`\${repoKey}-pr\${pr}\`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, \`\${commit.slice(0, 7)}.head-wait.json\`), JSON.stringify({ seen: ['one-head'] }));
process.exit(1);
`,
    );
    writeFileSync(
      join(sourceRepo, "package.json"),
      JSON.stringify({ scripts: { "review:wait": "node review-wait-stub.mjs" } }),
    );
    writeFileSync(
      join(sourceRepo, "package-lock.json"),
      '{"name":"lab","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"lab","version":"1.0.0"}}}\n',
    );
    sh(sourceRepo, "add", "review-wait-stub.mjs", "package.json", "package-lock.json");
    sh(sourceRepo, "commit", "-qm", "base");
    sh(sourceRepo, "push", "-q", "origin", "HEAD:main");
    const pushed = sh(sourceRepo, "rev-parse", "--verify", "refs/heads/main");
    const short = pushed.slice(0, 7);
    const factory: FactoryConfig = {
      evidence: EVIDENCE,
      repos: {
        lab: {
          github: "example/lab",
          path: ".",
          guard: "lab",
          check: "npm run check",
          tests: "\\.test\\.ts$",
          start: null,
          tickets: { sections: ["Result"], checklist: "Result" },
          board: true,
        },
      },
    };
    const ws: Workspace = {
      root: join(root, "run-8"),
      lab: sourceRepo,
      private: join(root, "private"),
      mainAtStart: {},
      fingerprints: {},
    };
    const npm: VerifyPrIo["npm"] = (cwd, args, timeoutMs) => realNpm(cwd, args, timeoutMs);
    const ghJson: VerifyPrIo["ghJson"] = ((..._args: string[]) => ({
      headRefOid: pushed,
      headRefName: "main",
    })) as VerifyPrIo["ghJson"];
    const git: VerifyPrIo["git"] = (cwd, ...args) => sh(cwd, ...args);

    const verifyRoot = join(root, "runs");
    const result = verifyPrWith({ ghJson, git, npm }, factory, verifyRoot, () => origin, ws, "lab", 7);

    expect(result.problems).toEqual([
      "Qodo's review of the agent's last commit isn't complete, or the pull request's head never became it",
    ]);
    const permanent = JSON.parse(
      readFileSync(join(sourceRepo, EVIDENCE, "reviews", "lab-pr7", `${short}.head-wait.json`), "utf8"),
    );
    expect(permanent.seen).toEqual(["one-head"]);
  });
});

describe("verifying the commit the agent pushed (Qodo on PR 98)", () => {
  const OLD = `506f56d${"0".repeat(33)}`;
  const PUSHED = `56fb13c${"1".repeat(33)}`;
  const ok = [{ name: "npm run check", conclusion: "SUCCESS" }];

  it("trusts the agent's branch tip over a PR view that still shows the old head", () => {
    expect(commitToVerify(PUSHED, OLD)).toBe(PUSHED);
  });

  it("falls back to the PR view's head only when the branch isn't in the worktree", () => {
    expect(commitToVerify(null, OLD)).toBe(OLD);
  });

  it("refuses anything that isn't a commit id, since it goes on an npm command line", () => {
    expect(commitToVerify("main; echo hi", OLD)).toBeNull();
    expect(commitToVerify(null, "")).toBeNull();
  });

  it("flags a PR view that still doesn't show the pushed commit after its review", () => {
    expect(prViewProblems({ state: "OPEN", headRefOid: OLD, statusCheckRollup: ok }, PUSHED)[0]).toMatch(
      /506f56d.*56fb13c/,
    );
  });

  it("passes an open PR at the pushed commit with green checks", () => {
    expect(prViewProblems({ state: "OPEN", headRefOid: PUSHED, statusCheckRollup: ok }, PUSHED)).toEqual([]);
  });

  it("still reports a closed PR and failing checks", () => {
    const problems = prViewProblems(
      { state: "CLOSED", headRefOid: PUSHED, statusCheckRollup: [{ name: "npm run check", conclusion: "FAILURE" }] },
      PUSHED,
    );
    expect(problems).toHaveLength(2);
  });
});
