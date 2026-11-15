/**
 * A lab ticket's run is kept out of the private checkouts however a command spells them (Qodo on PR 310): through
 * a variable that holds one (`${FAULTFORGE_PRIVATE_CHECKOUTS%%:*}`), and through a wildcard before the folder's
 * name (`priv*` followed by a folder, a bare star followed by `templates`, `cd priv?te`). Folders are made up under
 * the temp folder.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "./factory-policy.ts";

const BASE = mkdtempSync(join(tmpdir(), "policy-spellings-"));
const OWNER_PRIVATE = join(BASE, "owner-lab", "private");
const RUNS = join(BASE, "runs");
const RUN = join(RUNS, "r1");
const LAB = join(RUN, "lab");
const OWN_PRIVATE = join(LAB, "private");
for (const dir of [
  OWNER_PRIVATE,
  join(OWN_PRIVATE, "templates", "x-secret-v1"),
  join(OWN_PRIVATE, "cases"),
  join(OWN_PRIVATE, "raw-artifacts", "reviews", "faultforge-pr12"),
  join(LAB, "packages", "harness"),
  join(LAB, "docs"),
])
  mkdirSync(dir, { recursive: true });
writeFileSync(join(OWNER_PRIVATE, "README.md"), "x\n");
writeFileSync(join(OWN_PRIVATE, "ground-truth.jsonl"), "{}\n");
writeFileSync(join(OWN_PRIVATE, "README.md"), "x\n");
writeFileSync(join(OWN_PRIVATE, "cases", "FF-9001.json"), "{}\n");
writeFileSync(join(OWN_PRIVATE, "templates", "x-secret-v1", "template.json"), "{}\n");
writeFileSync(join(OWN_PRIVATE, "raw-artifacts", "reviews", "faultforge-pr12", "x.review.json"), "{}\n");
writeFileSync(join(LAB, "packages", "harness", "package.json"), "{}\n");
writeFileSync(join(LAB, "docs", "notes.md"), "x\n");

const ENV = {
  FAULTFORGE_FACTORY_RUN: "r1",
  FAULTFORGE_RUN_ROOT: RUN,
  FAULTFORGE_TICKET_NUMBER: "7",
  FAULTFORGE_PRIVATE_CHECKOUTS: [OWNER_PRIVATE, RUNS, OWN_PRIVATE].join(delimiter),
  FAULTFORGE_GUARD_PRIVATE_DIR: OWNER_PRIVATE,
  FAULTFORGE_TICKET_FILE: join(RUN, "ticket.md"),
};

function bash(command: string, cwd = LAB): string | undefined {
  const decision = decide(JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), ENV);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

describe("a variable that holds a private checkout doesn't hide it (Qodo on PR 310)", () => {
  it.each([
    `cd "\${FAULTFORGE_PRIVATE_CHECKOUTS%%${delimiter}*}" && cat README.md`,
    `cat "\${FAULTFORGE_PRIVATE_CHECKOUTS%%${delimiter}*}/README.md"`,
    `cd "\${FAULTFORGE_PRIVATE_CHECKOUTS##*${delimiter}}" && cat ground-truth.jsonl`,
    "cd $FAULTFORGE_GUARD_PRIVATE_DIR && cat README.md",
    'cat "${FAULTFORGE_GUARD_PRIVATE_DIR}/README.md"',
    "cat $FAULTFORGE_RUN_ROOT/lab/private/README.md",
    'cd "$FAULTFORGE_RUN_ROOT/lab/private" && ls',
    "cd ${FAULTFORGE_RUN_ROOT%/}/lab/private && ls",
    "x=FAULTFORGE_GUARD_PRIVATE_DIR; cd ${!x} && ls",
    "cd $(echo $FAULTFORGE_GUARD_PRIVATE_DIR) && ls",
    `node -e "console.log(process.env.FAULTFORGE_GUARD_PRIVATE_DIR)"`,
  ])("refuses %s", (command) => {
    expect(bash(command)).toBeDefined();
  });

  it.each([
    'cat "$FAULTFORGE_RUN_ROOT/lab/docs/notes.md"',
    "cd $FAULTFORGE_RUN_ROOT/lab/packages && ls",
    'echo "$FAULTFORGE_TICKET_NUMBER"',
    // The run's own files, though the runs folder they sit in is a checkout (Qodo on PR 312).
    `node -e "console.log(process.env.FAULTFORGE_TICKET_FILE)"`,
    'cat "$FAULTFORGE_TICKET_FILE"',
  ])("allows %s", (command) => {
    expect(bash(command)).toBeUndefined();
  });
});

describe("a wildcard before the private folder's name doesn't hide it (Qodo on PR 310)", () => {
  it.each([
    "cat priv*/cases/FF-9001.json",
    "cat priv*/templates/x-secret-v1/template.json",
    "cat */templates/x-secret-v1/template.json",
    "cat */ground-truth.jsonl",
    "echo x > priv*/ground-truth.jsonl",
    "cd priv?te && cat cases/FF-9001.json",
    "cd priv?te && cat README.md",
    "cd p[r]ivate && ls",
    "cat {private,docs}/README.md",
    "ls priv*",
    // A brace list past the most the policy expands still names the private worktree (Qodo on PR 312).
    `cat {docs,private}/README.md${"{,}".repeat(11)}`,
  ])("refuses %s", (command) => {
    expect(bash(command)).toBeDefined();
  });

  it.each([
    "cat packages/*/package.json",
    "cat */package.json",
    "ls doc*",
    "cat d?cs/notes.md",
    "cat priv*/raw-artifacts/reviews/faultforge-pr12/x.review.json",
  ])("allows %s", (command) => {
    expect(bash(command)).toBeUndefined();
  });
});
