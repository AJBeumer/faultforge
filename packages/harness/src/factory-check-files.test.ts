import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedCheckFiles,
  checkFilesVerdict,
  readCheckFiles,
  scriptsOf,
  TOUCHES_CHECK,
  touchesCheckLabel,
} from "./factory-check-files.ts";
import { configProblems, loadFactory } from "./factory-config.ts";
import type { IssueEvent } from "./factory-settle.ts";

const LAB = join(import.meta.dirname, "../../..");
const factory = loadFactory(join(LAB, "factory.json"));
const labConfig = factory.repos.faultforge?.checkFiles;
const targetConfig = factory.repos.target?.checkFiles;

describe("factory.json names the files that decide the check (#341)", () => {
  it("has a checkFiles setting for every repo, and the schema requires it", () => {
    for (const repo of Object.values(factory.repos)) expect(repo.checkFiles).toBeDefined();
    const raw = JSON.parse(readFileSync(join(LAB, "factory.json"), "utf8"));
    expect(configProblems(raw)).toEqual([]);
    delete raw.repos.target.checkFiles;
    expect(configProblems(raw).join("\n")).toMatch(/must have required property 'checkFiles'/);
  });

  it("refuses a setting that isn't a valid regular expression, or has an unknown field", () => {
    const raw = JSON.parse(readFileSync(join(LAB, "factory.json"), "utf8"));
    raw.repos.target.checkFiles.files = "(unclosed";
    expect(configProblems(raw).join("\n")).toMatch(/checkFiles\.files .* is not a valid regular expression/);
    raw.repos.target.checkFiles = { files: "x", scripts: "y", extra: "z" };
    expect(configProblems(raw).join("\n")).toMatch(/additional properties/);
  });

  it("covers the configs, the check workflow and the check's own scripts, not ordinary code or the lockfile", () => {
    const changed = (config: typeof labConfig, paths: string[]) =>
      changedCheckFiles(config ?? { files: "$^", scripts: "$^" }, paths, () => null);
    const shared = [
      "biome.json",
      "tsconfig.json",
      "tsconfig.test.json",
      "vitest.config.ts",
      "vitest.config.mts",
      "packages/x/vite.config.ts",
      ".github/workflows/check.yml",
      ".npmrc",
    ];
    expect(changed(targetConfig, [...shared, "src/app.ts", "test/app.test.ts", "package-lock.json"])).toEqual(
      [...shared].sort(),
    );
    const lab = ["packages/harness/src/vitest-run.ts", "packages/harness/src/docs-check.ts", "factory.json"];
    expect(changed(labConfig, [...shared, ...lab, "packages/harness/src/match.ts", "README.md"])).toEqual(
      [...shared, ...lab].sort(),
    );
  });
});

describe("docs/factory-trigger.md", () => {
  it("describes the check, its outcomes and the label", () => {
    const docs = readFileSync(join(LAB, "docs/factory-trigger.md"), "utf8");
    for (const word of [
      "`touches-check`",
      "`checkFiles`",
      "`check-files`",
      "`check-weakened`",
      "`allowed`",
      "`unread`",
    ]) {
      expect(docs).toContain(word);
    }
  });
});

describe("scriptsOf", () => {
  it("compares scripts in any key order, and tells a missing or broken file apart", () => {
    expect(scriptsOf('{"scripts":{"a":"1","b":"2"}}')).toBe(scriptsOf('{"scripts":{"b":"2","a":"1"},"x":1}'));
    expect(scriptsOf('{"scripts":{"a":"1"}}')).not.toBe(scriptsOf('{"scripts":{"a":"2"}}'));
    expect(scriptsOf(null)).not.toBe(scriptsOf("{}"));
    expect(scriptsOf("{oops")).not.toBe(scriptsOf("{}"));
  });
});

describe("touchesCheckLabel", () => {
  const at = (event: "labeled" | "unlabeled", by: string, when: string, name = TOUCHES_CHECK): IssueEvent => ({
    event,
    created_at: when,
    actor: { login: by },
    label: { name },
  });
  const START = "2026-11-09T09:30:00.000Z";

  it("counts the owner's label added before the agent started", () => {
    expect(touchesCheckLabel([at("labeled", "Owner", "2026-11-09T09:00:00Z")], "owner", START)).toEqual({
      by: "Owner",
      at: "2026-11-09T09:00:00Z",
    });
  });

  it("doesn't count anyone else's label, one added during the run, one taken off again, or another label", () => {
    expect(touchesCheckLabel([at("labeled", "someone", "2026-11-09T09:00:00Z")], "owner", START)).toBeNull();
    expect(touchesCheckLabel([at("labeled", "owner", "2026-11-09T09:31:00Z")], "owner", START)).toBeNull();
    expect(
      touchesCheckLabel(
        [at("unlabeled", "owner", "2026-11-09T09:10:00Z"), at("labeled", "owner", "2026-11-09T09:00:00Z")],
        "owner",
        START,
      ),
    ).toBeNull();
    expect(touchesCheckLabel([at("labeled", "owner", "2026-11-09T09:00:00Z", "other")], "owner", START)).toBeNull();
  });
});

describe("checkFilesVerdict", () => {
  const reading = { base: "b".repeat(40), head: "c".repeat(40), changed: ["vitest.config.ts"] };

  it("fails a change without the label as check-weakened, naming the paths", () => {
    const verdict = checkFilesVerdict(reading, null);
    expect(verdict.outcome).toBe("check-weakened");
    expect(verdict.event).toMatchObject({ outcome: "check-weakened", changed: ["vitest.config.ts"] });
    expect(verdict.problems[0]).toMatch(/^check-weakened: .*`vitest\.config\.ts`/);
  });

  it("allows it with the label, recording who set it and when", () => {
    const verdict = checkFilesVerdict(reading, { by: "owner", at: "2026-11-09T09:00:00Z" });
    expect(verdict).toMatchObject({ outcome: "allowed", problems: [] });
    expect(verdict.event).toMatchObject({ label: TOUCHES_CHECK, by: "owner", at: "2026-11-09T09:00:00Z" });
  });

  it("goes on when nothing changed, and fails closed when nothing could be read", () => {
    expect(checkFilesVerdict({ ...reading, changed: [] }, null).problems).toEqual([]);
    const unread = checkFilesVerdict({ error: "fetch failed" }, { by: "owner", at: "x" });
    expect(unread.outcome).toBe("unread");
    expect(unread.problems[0]).toMatch(/couldn't compare .*fetch failed/);
  });

  it("keeps a path's odd characters out of the ticket comment, never out of the log", () => {
    const verdict = checkFilesVerdict({ ...reading, changed: ["a`@b/tsconfig.json"] }, null);
    expect(verdict.problems[0]).toContain("`a??b/tsconfig.json`");
    expect(verdict.event.changed).toEqual(["a`@b/tsconfig.json"]);
  });
});

/**
 * A real repository standing in for GitHub: `main` holds the run's base, and each fake run's commit is pushed to
 * `refs/pull/<n>/head`, the ref GitHub keeps for a pull request. `readCheckFiles` fetches from it into a new
 * repository of its own.
 */
describe("readCheckFiles: the runner's own diff between the base and the PR's head", () => {
  let root: string;
  let origin: string;
  let work: string;
  let base: string;
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const PACKAGE = {
    name: "app",
    scripts: { check: "npm run lint && npm test", test: "vitest run" },
    dependencies: { a: "^1.0.0" },
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  };
  /** Commits `files` on top of the base and publishes it as pull request `pr`. */
  const pullRequest = (pr: number, files: Record<string, string>) => {
    sh(work, "checkout", "-q", "--detach", base);
    for (const [path, text] of Object.entries(files)) write(path, text);
    sh(work, "add", "-A");
    sh(work, "commit", "-qm", `change ${pr}`);
    sh(work, "push", "-q", "origin", `HEAD:refs/pull/${pr}/head`);
    return sh(work, "rev-parse", "HEAD");
  };
  const read = (pr: number, at = base) =>
    readCheckFiles(targetConfig, origin, at, pr, join(root, "runs", `check-files-pr${pr}`));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-files-test-"));
    origin = join(root, "origin.git");
    work = join(root, "work");
    sh(root, "init", "-q", "--bare", origin);
    sh(root, "clone", "-q", origin, work);
    sh(work, "config", "user.email", "t@example.com");
    sh(work, "config", "user.name", "t");
    sh(work, "config", "core.autocrlf", "false");
    write("package.json", `${JSON.stringify(PACKAGE, null, 2)}\n`);
    write("vitest.config.ts", "export default {};\n");
    write("src/app.ts", "export const x = 1;\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-qm", "base");
    sh(work, "push", "-q", "origin", "HEAD:main");
    base = sh(work, "rev-parse", "HEAD");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds a run that edits vitest.config.ts", () => {
    const head = pullRequest(1, { "vitest.config.ts": "export default { test: { exclude: ['**'] } };\n" });
    expect(read(1)).toEqual({ base, head, changed: ["vitest.config.ts"] });
  });

  it("finds a run that edits package.json scripts", () => {
    pullRequest(2, { "package.json": JSON.stringify({ ...PACKAGE, scripts: { ...PACKAGE.scripts, check: "true" } }) });
    expect(read(2)).toMatchObject({ changed: ["package.json"] });
  });

  it("allows a run that only edits package.json dependencies, or ordinary code", () => {
    pullRequest(3, {
      "package.json": JSON.stringify({ ...PACKAGE, dependencies: { a: "^2.0.0", b: "^1.0.0" } }),
      "src/app.ts": "export const x = 2;\n",
    });
    expect(read(3)).toMatchObject({ changed: [] });
  });

  it("finds a check config the run added or removed", () => {
    sh(work, "checkout", "-q", "--detach", base);
    sh(work, "rm", "-q", "vitest.config.ts");
    write("biome.json", "{}\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-qm", "swap");
    sh(work, "push", "-q", "origin", "HEAD:refs/pull/4/head");
    expect(read(4)).toMatchObject({ changed: ["biome.json", "vitest.config.ts"] });
  });

  it("reads the commits, never a worktree: changes the agent left uncommitted don't count either way", () => {
    pullRequest(5, { "src/app.ts": "export const x = 3;\n" });
    write("vitest.config.ts", "export default { test: { exclude: ['**'] } };\n");
    expect(read(5)).toMatchObject({ changed: [] });
  });

  it("fails closed, and leaves nothing behind, when the PR, the base or the setting is missing", () => {
    const dir = join(root, "runs", "check-files-pr9");
    expect(readCheckFiles(targetConfig, origin, base, 9, dir)).toHaveProperty("error");
    expect(existsSync(dir)).toBe(false);
    pullRequest(6, { "src/app.ts": "export const x = 6;\n" });
    expect(read(6, "f".repeat(40))).toHaveProperty("error");
    expect(read(6, "")).toEqual({ error: "no commit id for main when the run started" });
    expect(readCheckFiles(undefined, origin, base, 6, dir)).toEqual({
      error: "factory.json has no checkFiles setting for this repo",
    });
  });
});
