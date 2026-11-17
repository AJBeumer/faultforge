import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../fixtures/temp-dir.ts";
import type { FactoryConfig } from "../shared/factory-config.ts";
import { npm as realNpm } from "./factory-exec.ts";
import type { Workspace } from "./factory-tick.ts";
import {
  commitToVerify,
  prViewProblems,
  readJsonRecord,
  saveRecord,
  type VerifyPrIo,
  verifyPrWith,
} from "./factory-verify.ts";

describe("saveRecord: the runner's record replaces one the agent left, without copying the file", () => {
  it("saves the record into a folder that doesn't exist yet", () => {
    const dir = tempDir("save-record-");
    writeFileSync(join(dir, "runner.json"), '{"exit":0}');
    const to = join(dir, "evidence", "revert-checks", "faultforge-pr394", "b18eace.revert-check.json");
    saveRecord(join(dir, "runner.json"), to, dir);
    expect(readFileSync(to, "utf8")).toBe('{"exit":0}');
  });

  it("replaces a file already at the destination with the runner's record", () => {
    const dir = tempDir("save-record-");
    writeFileSync(join(dir, "runner.json"), '{"exit":0}');
    writeFileSync(join(dir, "agent.json"), '{"exit":0,"from":"the agent, longer than the runner record"}');
    saveRecord(join(dir, "runner.json"), join(dir, "agent.json"), dir);
    expect(readFileSync(join(dir, "agent.json"), "utf8")).toBe('{"exit":0}');
  });

  it("refuses a link where the record goes, and writes nothing through it", (ctx) => {
    const dir = tempDir("save-record-");
    const outside = tempDir("save-record-outside-");
    writeFileSync(join(dir, "runner.json"), '{"exit":0}');
    writeFileSync(join(outside, "precious.txt"), "keep me");
    try {
      symlinkSync(join(outside, "precious.txt"), join(dir, "record.json"), "file");
    } catch {
      return ctx.skip(); // this system lets no unprivileged user make a file link (Windows without developer mode)
    }
    expect(() => saveRecord(join(dir, "runner.json"), join(dir, "record.json"), dir)).toThrow(/is a link/);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("refuses a linked folder on the way to the record, and writes nothing through it", () => {
    const dir = tempDir("save-record-");
    const outside = tempDir("save-record-outside-");
    writeFileSync(join(dir, "runner.json"), '{"exit":0}');
    // A junction on Windows, which needs no privilege; a plain folder link elsewhere.
    symlinkSync(outside, join(dir, "evidence"), "junction");
    const to = join(dir, "evidence", "pr", "record.json");
    expect(() => saveRecord(join(dir, "runner.json"), to, dir)).toThrow(/is a link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("leaves the existing record as it was when the runner's record can't be read", () => {
    const dir = tempDir("save-record-");
    writeFileSync(join(dir, "record.json"), '{"exit":0}');
    expect(() => saveRecord(join(dir, "missing.json"), join(dir, "record.json"), dir)).toThrow(/ENOENT/);
    expect(readFileSync(join(dir, "record.json"), "utf8")).toBe('{"exit":0}');
  });

  it("refuses a destination outside the root it is given", () => {
    const dir = tempDir("save-record-");
    writeFileSync(join(dir, "runner.json"), '{"exit":0}');
    expect(() => saveRecord(join(dir, "runner.json"), join(dir, "..", "elsewhere.json"), dir)).toThrow(/not inside/);
  });

  it("never copies the file or sets its mode, which only the file's owner may do", () => {
    // Seen in Actions: copying over the agent's own record failed with EPERM, after the copy set the file's mode.
    const body = saveRecord.toString();
    expect(body).not.toMatch(/copyFile|cpSync|chmod|chown/);
    const source = readFileSync(join(import.meta.dirname, "factory-verify.ts"), "utf8");
    expect(source).not.toMatch(/\bcopyFileSync\(/);
  });
});

describe("readJsonRecord: never throws on a missing or damaged file", () => {
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

describe("verifyPrWith: review:wait runs from the trusted checkout, never the agent's worktree", () => {
  let root: string;
  const sh = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const EVIDENCE = "evidence";

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A stand-in for `review-wait.ts`, run through real `npm run`, so the test proves npm picks the script
   * of whichever checkout it runs from. It saves `openFindings` where `verifyPrWith` reads them back. */
  function reviewWaitStub(openFindings: unknown[], recordHead?: string, rounds: number | null = 1): string {
    return `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [repoKey, pr, , commit] = process.argv.slice(2);
const dir = join(process.cwd(), 'evidence', 'reviews', \`\${repoKey}-pr\${pr}\`);
mkdirSync(dir, { recursive: true });
const openFindings = ${JSON.stringify(openFindings)};
writeFileSync(join(dir, \`\${commit.slice(0, 7)}.review.json\`), JSON.stringify({ headSha: ${JSON.stringify(recordHead ?? null)} ?? commit, state: 'complete', reviewRounds: ${JSON.stringify(rounds)}, openFindings }));
`;
  }

  // The real revert-check.ts finds the PR's head itself. This stub isn't under test, so the npm wrapper
  // hands it the commit through the environment, only to name the record file `verifyPrWith` reads.
  const REVERT_CHECK_STUB = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [repoKey, pr] = process.argv.slice(2);
const dir = join(process.cwd(), 'evidence', 'revert-checks', \`\${repoKey}-pr\${pr}\`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, \`\${process.env.FAKE_SHORT}.revert-check.json\`), JSON.stringify({ exit: 0 }));
`;

  /**
   * `origin`'s main holds the genuine stub, which reports one open finding. `sourceRepo` stands in for the
   * agent's worktree: its branch edits that script to always report a clean review, as an agent's own pull
   * request could.
   */
  function sourceWithForgedStub(
    genuine: unknown[] = [{ severity: "action_required", title: "a real finding Qodo raised" }],
    recordHead?: string,
    rounds: number | null = 1,
  ) {
    root = mkdtempSync(join(tmpdir(), "verify-pr-with-test-"));
    const origin = join(root, "origin.git");
    const sourceRepo = join(root, "source");
    sh(root, "init", "-q", "--bare", origin);
    sh(root, "clone", "-q", origin, sourceRepo);
    sh(sourceRepo, "config", "user.email", "t@example.com");
    sh(sourceRepo, "config", "user.name", "t");
    writeFileSync(join(sourceRepo, "review-wait-stub.mjs"), reviewWaitStub(genuine, recordHead, rounds));
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

  /** Runs the runner's check on a source made by `sourceWithForgedStub`, under the checked-in gate's labels. */
  function verify({ sourceRepo, origin, pushed }: ReturnType<typeof sourceWithForgedStub>, sandbox = false) {
    const short = pushed.slice(0, 7);
    const factory: FactoryConfig = {
      evidence: EVIDENCE,
      gate: { fix: ["action_required", "remediation_recommended"], flag: ["informational"], maxRounds: 3 },
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
    // The real npm: the script that runs is whatever `package.json` at `cwd` names.
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
    const result = verifyPrWith({ ghJson, git, npm }, factory, verifyRoot, () => origin, ws, "lab", 42, sandbox);
    return { result, calls, verifyRoot, short };
  }

  it("settles the verdict from the real checkout's script, never the doctored worktree's", () => {
    const source = sourceWithForgedStub();
    const { sourceRepo } = source;
    const { result, calls, verifyRoot, short } = verify(source, true);

    // In a CI run the PR's tests run as the sandbox user: revert:check is told so.
    const revertCall = calls.find((c) => c.args.includes("revert:check"));
    expect(revertCall?.args.slice(-3)).toEqual(["lab", "42", "--sandbox"]);
    expect(result.problems).toEqual(["1 action_required (High) finding(s) still open: a real finding Qodo raised"]);
    const reviewCall = calls.find((c) => c.args.includes("review:wait"));
    expect(reviewCall?.cwd).not.toBe(sourceRepo);
    // The genuine finding reached the permanent evidence path before the trusted checkout was removed.
    const permanent = JSON.parse(
      readFileSync(join(sourceRepo, EVIDENCE, "reviews", "lab-pr42", `${short}.review.json`), "utf8"),
    );
    expect(permanent.openFindings).toEqual([{ severity: "action_required", title: "a real finding Qodo raised" }]);
    // Nothing of the trusted checkout lingers to tamper with afterwards.
    expect(existsSync(verifyRoot)).toBe(true);
    expect(readdirSync(verifyRoot)).toHaveLength(0);
  });

  // The agent's branch says the review is clean each time; the runner's own read of the review decides.
  it.each([
    [
      "an open remediation-recommended finding",
      [{ severity: "remediation_recommended", title: "an unread page" }],
      undefined,
      ["1 remediation_recommended (Medium) finding(s) still open: an unread page"],
    ],
    [
      "an open finding with a label the gate doesn't know",
      [{ severity: "blocker", title: "a new kind" }],
      undefined,
      ["1 open finding(s) with a label the gate doesn't know (blocker): a new kind"],
    ],
    [
      "a record of another commit",
      [],
      "e".repeat(40),
      [expect.stringMatching(/^the saved review is of eeeeeee, not of /)],
      1,
    ],
    [
      "more review rounds than the gate allows",
      [],
      undefined,
      ["4 review rounds have run on the pull request, more than the gate's 3"],
      4,
    ],
    [
      "a record that doesn't give its review rounds",
      [],
      undefined,
      ["the saved review doesn't say how many review rounds have run"],
      null,
    ],
  ])("doesn't count a pull request as delivered with %s", (_name, genuine, recordHead, problems, rounds = 1) => {
    const { result } = verify(sourceWithForgedStub(genuine, recordHead, rounds));
    expect(result.problems).toEqual(problems);
  });

  it("counts a pull request with only informational findings open as delivered", () => {
    const { result } = verify(sourceWithForgedStub([{ severity: "informational", title: "a name" }]));
    expect(result.problems).toEqual([]);
  });

  it("keeps review:wait's evidence even when the review doesn't complete", () => {
    // A timed-out review still saves what it saw (here, a head-wait record) before its non-zero exit.
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

describe("verifying the commit the agent pushed", () => {
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
