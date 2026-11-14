/**
 * The guard reads text as the shell would post it (#285): the re-grade after round 4 got these spellings
 * through. Each is a payload the hook gets, judged by its decision.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leetReadings, telltales } from "../../packages/harness/src/neutral.ts";
import { hookFileProblem, MIN_HOOK_BYTES, run } from "./fail-closed.ts";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { expandVariables, type RepositoryResolver, setRepositoryResolver, shellReading } from "./guard-expand.ts";
import { privateIdMatcher } from "./guard-private.ts";
import { rewritesHistory } from "./guard-reach.ts";
import { decide } from "./guard-target.ts";

const LAB = "D:\\Projects\\FaultForge";
const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
const T = "AJBeumer/faultforge-target";

/** A private folder holding one unreleased template, with a made-up id. */
function privateFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-decode-private-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
}
const PRIVATE = privateFolder();
const NO_PRIVATE = join(tmpdir(), "guard-decode-none");

function verdict(command: string, cwd = LAB, priv = PRIVATE): string | undefined {
  const payload = JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
  const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: priv });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

describe("a lab post is read as strictly as a post to a reviewed repo while private templates exist", () => {
  it.each([
    ["printf", `gh pr create --title Tidy --body "$(printf 'x-sec%s' 'ret-v1')"`],
    ["base64", `gh pr create --title Tidy --body "$(echo eC1zZWNyZXQtdjE= | base64 -d)"`],
    ["a variable join", 'S=x-sec; gh pr create --title Tidy --body "${S}ret-v1"'],
    ["ANSI-C hex", String.raw`gh pr create --title Tidy --body $'x-sec\x72et-v1'`],
    ["a variable the command doesn't set", 'gh pr create --title Tidy --body "$BODY"'],
    ["printf piped in", `printf 'x-sec%s' 'ret-v1' | gh pr create --title Tidy --body-file -`],
    ["leetspeak", 'gh pr create --title Tidy --body "x-s3cr3t-v1"'],
  ])("refuses %s", (_name, command) => {
    expect(verdict(command)).toBeDefined();
  });

  it("allows a lab post whose text it can read, and any post when there are no private templates", () => {
    expect(verdict('gh pr create --title Tidy --body "Small cleanup"')).toBeUndefined();
    expect(verdict('S=cleanup; gh pr create --title Tidy --body "Small $S"')).toBeUndefined();
    expect(verdict(`gh pr create --title Tidy --body "$(printf 'x-sec%s' 'ret-v1')"`, LAB, NO_PRIVATE)).toBeUndefined();
  });
});

describe("ANSI-C strings and variables before the word and link checks (AUD-M3)", () => {
  it("decodes $'…' before the giveaway words, to a reviewed repo", () => {
    expect(verdict(String.raw`gh pr comment 3 -R ${T} -b $'pla\x6eted bug'`)).toMatch(/says planted/);
  });

  it("decodes $'…' before the link check, from the lab", () => {
    expect(verdict(String.raw`gh issue create --title x --body $'${T}\x233'`, LAB, NO_PRIVATE)).toMatch(
      /link to the target/,
    );
  });

  it("refuses a body from a variable the command doesn't set, posted to a reviewed repo", () => {
    expect(verdict(`gh pr comment 3 -R ${T} -b "$MSG"`, LAB, NO_PRIVATE)).toMatch(/shell variable/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a JS template
    expect(verdict(`gh pr comment 3 -R ${T} -b "\${MSG}"`, LAB, NO_PRIVATE)).toMatch(/shell variable/);
    // A literal '$MSG' in single quotes is text, not a variable.
    expect(verdict(`gh pr comment 3 -R ${T} -b 'costs $MSG'`, LAB, NO_PRIVATE)).toBeUndefined();
  });

  it("expands a variable the command sets, and judges the text it makes", () => {
    expect(verdict(`R=${T}; gh issue comment 3 --repo "$R" --body "planted bug"`, LAB, NO_PRIVATE)).toBeDefined();
    // A prefix doesn't set what the command's own words expand to: the variable stays unreadable.
    expect(verdict(`R=${T} gh issue comment 3 --repo "$R" --body "ok"`, LAB, NO_PRIVATE)).toMatch(/shell variable/);
    expect(verdict(`M=pla gh pr comment 3 -R ${T} -b "\${M}nted bug"`, LAB, NO_PRIVATE)).toMatch(/shell variable/);
    expect(expandVariables('A=x; B="y"; echo "$A$B ${A}"')).toBe('A=x; B="y"; echo "xy x"');
  });

  it("expands as the shell does: in order, from statements of their own only (Qodo on PR 291)", () => {
    expect(expandVariables("echo $A; A=x; echo $A")).toBe("echo $A; A=x; echo x");
    expect(expandVariables("FLAG=--force; FLAG=-u git push $FLAG")).toBe("FLAG=--force; FLAG=-u git push --force");
    expect(expandVariables("gh pr comment 3 -b 'R=safe $R'")).toBe("gh pr comment 3 -b 'R=safe $R'");
  });

  it("reads every quoted part of a posted word, and lets an escaped dollar sign be (Qodo on PR 291)", () => {
    expect(verdict(`gh pr comment 3 -R ${T} -b 'safe '"$MSG"`, LAB, NO_PRIVATE)).toMatch(/shell variable/);
    expect(verdict(`gh pr comment 3 -R ${T} -b "costs \\$MSG"`, LAB, NO_PRIVATE)).toBeUndefined();
  });

  it("posts a literal heredoc from the lab while private templates exist, and still finds an id in it (Qodo on PR 291)", () => {
    const body = (text: string) => `gh pr create --title Tidy --body "$(cat <<'EOF'\n${text}\nEOF\n)"`;
    expect(verdict(body("Small cleanup."))).toBeUndefined();
    expect(verdict(body("Demo with x-secret-v1."))).toMatch(/still private/);
  });

  it("refuses a write whose repo is a variable the command doesn't set", () => {
    expect(verdict(`gh issue comment 3 --repo "$R" --body "ok"`, LAB, NO_PRIVATE)).toMatch(/shell variable/);
  });

  it("reads a .git suffix and a percent-encoded route as the repo they name", () => {
    expect(verdict(`gh pr comment 3 -R ${T}.git -b "planted bug"`, LAB, NO_PRIVATE)).toMatch(/says planted/);
    expect(
      verdict(
        'gh api repos/AJBeumer/faultforge%2Dtarget/issues/3/comments -f body="planted bug FF-0012"',
        LAB,
        NO_PRIVATE,
      ),
    ).toMatch(/says planted/);
  });
});

describe("aliases, default repos and repository ids (AUD-M3)", () => {
  let before: RepositoryResolver | undefined;
  afterEach(() => {
    if (before) setRepositoryResolver(before);
    before = undefined;
  });

  it("refuses gh alias set and import", () => {
    expect(verdict(`gh alias set c 'issue comment 3 -R ${T} -b'`, LAB, NO_PRIVATE)).toMatch(/aliases/);
    expect(verdict("gh alias import aliases.yml", LAB, NO_PRIVATE)).toMatch(/aliases/);
  });

  it("refuses a default repo of a reviewed repo set from elsewhere", () => {
    expect(verdict(`gh repo set-default ${T}`, LAB, NO_PRIVATE)).toMatch(/default repo/);
  });

  it("names a repository id before judging the write, and refuses one it can't resolve", () => {
    const asked: string[] = [];
    before = setRepositoryResolver((id) => {
      asked.push(id);
      return id === "111" ? T : id === "222" ? "someone/else" : undefined;
    });
    const post = (id: string) => `gh api repositories/${id}/issues/3/comments -f body="planted bug FF-0012"`;
    expect(verdict(post("111"), LAB, NO_PRIVATE)).toMatch(/says planted/);
    expect(verdict(post("222"), LAB, NO_PRIVATE)).toBeUndefined();
    expect(verdict(post("333"), LAB, NO_PRIVATE)).toMatch(/couldn't tell which repo/);
    expect(asked).toEqual(["111", "222", "333"]);
    // A write only once its method is expanded; an id in a message is words (Qodo on PR 291).
    expect(
      verdict('M=PUT; gh api repositories/111/pulls/1/merge -X $M -f commit_title="planted"', LAB, NO_PRIVATE),
    ).toBeDefined();
    expect(asked.at(-1)).toBe("111");
    asked.length = 0;
    expect(
      verdict("gh issue create --repo owner/name --title x --body 'see repositories/0'", LAB, NO_PRIVATE),
    ).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe("leetspeak (AUD-M3)", () => {
  it("folds digits and signs into letters, beside the text as written", () => {
    expect(leetReadings("pl@nt3d $abotage 1edger")).toEqual(["planted sabotage iedger", "planted sabotage ledger"]);
    expect(telltales("pl4nt3d bug")).toContain("says planted");
    expect(telltales("p1anted")).toContain("says planted");
    expect(telltales("$ab0tage")).toContain("says sabotage");
    expect(telltales("f4ultf0rge")).toContain("names the lab");
    // Case ids are digits: the text as written still shows them.
    expect(telltales("FF-0012")).toContain("contains a case id");
    expect(telltales("Fix the 404 on page 3")).toEqual([]);
  });

  it("refuses a leetspeak post to a reviewed repo", () => {
    expect(verdict(`gh pr comment 3 -R ${T} -b "pl@nted bug, plant3d"`, LAB, NO_PRIVATE)).toMatch(/says planted/);
  });

  it("reads private ids in leetspeak too, and still tells a longer id apart", () => {
    const names = privateIdMatcher(["x-secret-v1"]);
    expect(names?.("x-s3cr3t-v1")).toBe(true);
    expect(names?.("x-secret-v10")).toBe(false);
  });
});

describe("a force push built from a variable (AUD-M3)", () => {
  it("is a force push in a reviewed checkout unless the command sets the flag to something harmless", () => {
    expect(verdict("git push $FLAG origin main", TARGET_REPO.dir, NO_PRIVATE)).toMatch(/Force pushes/);
    // A prefix doesn't set what the push's own words expand to (Qodo on PR 291).
    expect(verdict("FLAG=-u git push $FLAG origin x", TARGET_REPO.dir, NO_PRIVATE)).toMatch(/Force pushes/);
    expect(rewritesHistory(shellReading("FLAG=--force; FLAG=-u git push $FLAG origin x"), true)).toBe(true);
    // Set on its own, to a harmless flag, it reads as that flag.
    expect(rewritesHistory(shellReading("FLAG=-u; git push $FLAG origin x"), true)).toBe(false);
  });
});

describe("the fail-closed wrapper refuses a hook file that can't be the hook (AUD-M4)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "guard-hookfile-"));
  const file = (name: string, text: string) => {
    const path = join(scratch, name);
    writeFileSync(path, text);
    return path;
  };
  const real = join(import.meta.dirname, "guard-target.ts");

  it("accepts both real hooks", () => {
    expect(hookFileProblem(real)).toBeUndefined();
    expect(hookFileProblem(join(import.meta.dirname, "factory-policy.ts"))).toBeUndefined();
  });

  it.each([
    ["emptied", ""],
    ["truncated", "export function decide(stdin) {\n"],
    ["a one-line allow", "process.exit(0)"],
    ["padded but without decide", `// ${"x".repeat(MIN_HOOK_BYTES)}\nif (isEntry(import.meta.url)) main();\n`],
    ["padded with decide but no entry point", `export function decide() {}\n// ${"x".repeat(MIN_HOOK_BYTES)}\n`],
  ])("refuses a hook file %s", (_name, text) => {
    const hook = file(`${_name.replace(/\W+/g, "-")}.ts`, text);
    expect(hookFileProblem(hook)).toBeDefined();
    const result = run([hook], () => Buffer.from("{}"));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/refused/);
  });
});
