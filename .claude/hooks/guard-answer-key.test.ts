/**
 * Copies of private storage (#335; re-grade 6, Q21): the answer key, the audit log and a still-private template's
 * files are never copied out of private storage, written into another file, or committed in the lab. The lab's
 * pre-commit and commit-msg hooks refuse them too, whoever runs git. Compared by hash, never printed. The private
 * folder and its contents are made up for the test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { check } from "./git-guard.ts";
import { MIN_CHARS, privateCopyTest } from "./guard-answer-key.ts";
import { COPIES_PRIVATE } from "./guard-content.ts";
import { decide } from "./guard-target.ts";

const TARGET = tempRepo(true);
const CONFIG = guardConfig(TARGET.dir);
/** The lab, with private storage inside it as `private/`, ignored, as the owner keeps them. */
const LAB = tempRepo(true);
writeFileSync(join(LAB.dir, ".gitignore"), "private/\n");
mkdirSync(join(LAB.dir, "docs"));
LAB.git("add", ".gitignore");
LAB.git("commit", "-q", "-m", "Ignore private storage");
LAB.git("push", "-q", "origin", "main");
const PRIVATE = join(LAB.dir, "private");
const KEY_LINE = JSON.stringify({ caseId: "FF-9001", templateId: "x-secret-v1", injectedFile: "src/a.ts" });
const AUDIT_LINE = JSON.stringify({ type: "pr.opened", caseId: "FF-9001", repo: "o/t", pr: 7 });
const TEMPLATE = "export const invariant = 'totals include every booking';\n";
mkdirSync(join(PRIVATE, "templates", "x-secret-v1"), { recursive: true });
writeFileSync(join(PRIVATE, "ground-truth.jsonl"), `${KEY_LINE}\n`);
writeFileSync(join(PRIVATE, "audit-events.jsonl"), `${AUDIT_LINE}\n`);
writeFileSync(join(PRIVATE, "templates", "x-secret-v1", "proof.ts"), TEMPLATE);
const ELSEWHERE = mkdtempSync(join(tmpdir(), "guard-key-elsewhere-"));
const ENV = { FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE };

function ask(tool: string, input: object, cwd = LAB.dir): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, ...ENV };
  delete env.FAULTFORGE_FACTORY_RUN;
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), env);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd = LAB.dir) => ask("Bash", { command }, cwd);

/** Leaves the lab with nothing staged and no copy in its docs. */
afterEach(() => {
  LAB.git("reset", "-q");
  rmSync(join(LAB.dir, "docs"), { recursive: true, force: true });
  mkdirSync(join(LAB.dir, "docs"));
  vi.unstubAllEnvs();
});

describe("private content is told by hash", () => {
  it("knows a line of either log, and a template's whole file, however it is wrapped", () => {
    const test = privateCopyTest({ FAULTFORGE_PRIVATE_DIR: PRIVATE }, LAB.dir);
    expect(test?.(`notes\n  ${KEY_LINE}\r\nmore`)).toBe(true);
    expect(test?.(AUDIT_LINE)).toBe(true);
    expect(test?.(TEMPLATE.replace(/\n/g, "\r\n"))).toBe(true);
    expect(test?.("an ordinary file with nothing private in it")).toBe(false);
    expect(test?.("}")).toBe(false);
    expect(MIN_CHARS).toBeGreaterThan(10);
  });

  it("has nothing to protect where there is no private folder", () => {
    expect(privateCopyTest({ FAULTFORGE_PRIVATE_DIR: join(ELSEWHERE, "none") }, LAB.dir)).toBeUndefined();
  });
});

describe("no copy of private storage leaves it (Q21)", () => {
  it.each([
    "cp private/ground-truth.jsonl docs/ && git add docs && git commit -m docs",
    "cp private/audit-events.jsonl docs/log.jsonl",
    "cp private/templates/x-secret-v1/proof.ts docs/",
    "cp -r private/templates docs/",
    "cp -r private docs/",
    "mv private/ground-truth.jsonl docs/",
    "cat private/ground-truth.jsonl > docs/key.jsonl",
    "cat private/ground-truth.jsonl | tee docs/key.jsonl",
    "grep FF private/audit-events.jsonl | sort > docs/x.txt",
    // An input redirect, dd, and a path the guard can't read that names the private folder (Qodo on PR 337).
    "dd if=private/ground-truth.jsonl of=docs/key.jsonl",
    "tee docs/key.jsonl < private/ground-truth.jsonl",
    'cp "$FAULTFORGE_PRIVATE_DIR/ground-truth.jsonl" docs/key.jsonl',
    // Forward slashes: a backslash is a separator on Windows only, and the test runs on Linux too.
    "Copy-Item -Path private/ground-truth.jsonl -Destination docs/",
  ])("refuses %s", (command) => {
    expect(bash(command)).toMatch(/copy the answer key/);
  });

  it("still reads and copies within private storage, and copies ordinary files", () => {
    for (const command of [
      "cat private/ground-truth.jsonl",
      "cp private/ground-truth.jsonl private/backup.jsonl",
      "cp README.md docs/readme-copy.md",
      "wc -l private/audit-events.jsonl",
    ]) {
      expect(bash(command), command).toBeUndefined();
    }
  });

  it("refuses a Write or Edit that puts private content in a file outside private storage, never printing it", () => {
    const reason = ask("Write", { file_path: join(LAB.dir, "docs", "notes.md"), content: `See:\n${KEY_LINE}\n` });
    expect(reason).toMatch(/copy the answer key/);
    expect(reason).not.toContain("FF-9001");
    expect(ask("Write", { file_path: join(ELSEWHERE, "t.ts"), content: TEMPLATE })).toMatch(/copy the answer key/);
    expect(ask("Edit", { file_path: join(LAB.dir, "README.md"), old_string: "# App", new_string: AUDIT_LINE })).toMatch(
      /copy the answer key/,
    );
    expect(ask("Write", { file_path: join(PRIVATE, "copy.jsonl"), content: KEY_LINE })).toBeUndefined();
  });
});

describe("a lab commit can't carry a copy (Q21)", () => {
  it("refuses a git commit while a copy is staged, or would be by -a or a chained add", () => {
    writeFileSync(join(LAB.dir, "docs", "key.jsonl"), `${KEY_LINE}\n`);
    expect(bash("git add docs && git commit -m docs")).toMatch(/copies the answer key/);
    LAB.git("add", "docs");
    const reason = bash("git commit -m docs");
    expect(reason).toMatch(/copies the answer key/);
    expect(reason).not.toContain("FF-9001");
    expect(bash(`git -C ${LAB.dir.replace(/\\/g, "/")} commit -m docs`, ELSEWHERE)).toMatch(/copies the answer key/);
  });

  it("refuses a template's file in a commit", () => {
    writeFileSync(join(LAB.dir, "docs", "proof.ts"), TEMPLATE);
    LAB.git("add", "docs");
    expect(bash("git commit -m tests")).toMatch(/copies the answer key/);
  });

  it("still commits ordinary changes in the lab, with its own words", () => {
    writeFileSync(join(LAB.dir, "docs", "notes.md"), "The planted bug in case FF-9001 was caught.\n");
    LAB.git("add", "docs");
    expect(bash('git commit -m "Notes on the planted bug"')).toBeUndefined();
  });

  it("is refused by the lab's pre-commit hook, whoever runs git", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", PRIVATE);
    vi.stubEnv("FAULTFORGE_CONFIG", CONFIG);
    writeFileSync(join(LAB.dir, "docs", "log.jsonl"), `${AUDIT_LINE}\n`);
    LAB.git("add", "docs");
    expect(check("lab-pre-commit", LAB.dir)?.reasons).toContain(COPIES_PRIVATE);
    LAB.git("reset", "-q");
    writeFileSync(join(LAB.dir, "docs", "log.jsonl"), "ordinary text, nothing private here\n");
    LAB.git("add", "docs");
    expect(check("lab-pre-commit", LAB.dir)).toBeUndefined();
  });

  it("is refused by the lab's commit-msg hook when the message carries a line", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", PRIVATE);
    vi.stubEnv("FAULTFORGE_CONFIG", CONFIG);
    const message = join(ELSEWHERE, "COMMIT_EDITMSG");
    writeFileSync(message, `Tidy\n\n${KEY_LINE}\n`);
    expect(check("lab-commit-msg", LAB.dir, message)?.reasons).toContain(COPIES_PRIVATE);
    writeFileSync(message, "Tidy the notes\n");
    expect(check("lab-commit-msg", LAB.dir, message)).toBeUndefined();
  });

  it("is refused by a reviewed repo's pre-commit hook too", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", PRIVATE);
    vi.stubEnv("FAULTFORGE_CONFIG", CONFIG);
    writeFileSync(join(TARGET.dir, "data.ts"), TEMPLATE);
    TARGET.git("add", "data.ts");
    try {
      expect(check("pre-commit", TARGET.dir)?.reasons).toContain(COPIES_PRIVATE);
    } finally {
      TARGET.git("rm", "-q", "--cached", "data.ts");
      rmSync(join(TARGET.dir, "data.ts"));
    }
  });
});

describe("commits and pushes carry no copy either (Qodo on PR 337)", () => {
  /** The update line git hands a pre-push hook for `main`. */
  const update = (repo: typeof LAB) =>
    `refs/heads/main ${repo.git("rev-parse", "HEAD").trim()} refs/heads/main ${repo.git("rev-parse", "origin/main").trim()}\n`;

  it("is refused by a reviewed repo's commit-msg hook", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", PRIVATE);
    vi.stubEnv("FAULTFORGE_CONFIG", CONFIG);
    const message = join(ELSEWHERE, "TARGET_EDITMSG");
    writeFileSync(message, `Tidy\n\n${AUDIT_LINE}\n`);
    expect(check("commit-msg", TARGET.dir, message)?.reasons).toContain(COPIES_PRIVATE);
  });

  it("is refused by a reviewed repo's pre-push hook, for a copy committed earlier", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", PRIVATE);
    vi.stubEnv("FAULTFORGE_CONFIG", CONFIG);
    writeFileSync(join(TARGET.dir, "data.ts"), TEMPLATE);
    TARGET.git("add", "data.ts");
    TARGET.git("commit", "-q", "--no-verify", "-m", "Add data");
    try {
      expect(check("pre-push", TARGET.dir, "origin", update(TARGET))?.reasons).toContain(COPIES_PRIVATE);
    } finally {
      TARGET.git("reset", "-q", "--hard", "origin/main");
    }
  });

  it("is refused by the lab's pre-push hook, for a copy committed before its pre-commit hook", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", PRIVATE);
    vi.stubEnv("FAULTFORGE_CONFIG", CONFIG);
    writeFileSync(join(LAB.dir, "docs", "key.jsonl"), `${KEY_LINE}\n`);
    LAB.git("add", "docs");
    LAB.git("commit", "-q", "--no-verify", "-m", "Add notes");
    const url = LAB.git("remote", "get-url", "origin").trim();
    try {
      expect(check("lab-pre-push", LAB.dir, "origin", update(LAB), url)?.reasons).toContain(COPIES_PRIVATE);
    } finally {
      LAB.git("reset", "-q", "--hard", "origin/main");
    }
  });
});
