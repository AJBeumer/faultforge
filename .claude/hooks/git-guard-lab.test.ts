/**
 * The lab's own git hooks (re-grade 5): links go one way, so a lab commit message may name target work as plain
 * text, never link a reviewed repo's issue or PR. git runs these for every commit and push, whatever started it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempRepo } from "./fixtures.ts";
import { check, LINK_REASON } from "./git-guard.ts";

const ZERO = "0".repeat(40);
const T = "AJBeumer/faultforge-target";

/** A lab clone with a bare origin, and a commit on top whose message is `message`. */
function lab(message: string) {
  const repo = tempRepo(true);
  const base = repo.git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo.dir, "a.md"), "One\n");
  repo.git("add", "a.md");
  repo.git("commit", "-q", "-m", message);
  return { ...repo, base, head: repo.git("rev-parse", "HEAD").trim() };
}

const update = (local: string, remote: string, ref = "refs/heads/main") => `refs/heads/x ${local} ${ref} ${remote}\n`;

describe("the lab's commit-msg hook refuses target links (re-grade 5)", () => {
  it.each([
    `Tidy\n\nRefs: ${T}#3\n`,
    `Tidy\n\nSee https://github.com/${T}/issues/3\n`,
    `Tidy\n\nSee https://github.com/${T}/pull/12\n`,
    "Tidy, faultforge-target#4\n",
  ])("refuses %j", (message) => {
    const { dir } = tempRepo();
    const file = join(dir, "MSG");
    writeFileSync(file, message);
    expect(check("lab-commit-msg", dir, file)?.reasons).toEqual([LINK_REASON]);
  });

  it("allows plain text and a link to the lab's own issues", () => {
    const { dir } = tempRepo();
    const file = join(dir, "MSG");
    writeFileSync(file, "Tidy the planted case notes for target 3\n\nCloses #12\n");
    expect(check("lab-commit-msg", dir, file)).toBeUndefined();
  });
});

describe("the lab's pre-push hook refuses target links in the commits it sends (re-grade 5)", () => {
  it("refuses a pushed commit whose message links a target PR", () => {
    const { dir, base, head } = lab(`Tidy\n\nRefs ${T}#3`);
    expect(check("lab-pre-push", dir, "origin", update(head, base))?.reasons).toEqual([LINK_REASON]);
    expect(check("lab-pre-push", dir, "origin", update(head, ZERO, "refs/heads/new"))?.reasons).toEqual([LINK_REASON]);
  });

  it("allows a clean push, a deletion, and commits the remote already has", () => {
    const clean = lab("Tidy for target 3");
    expect(check("lab-pre-push", clean.dir, "origin", update(clean.head, clean.base))).toBeUndefined();
    expect(check("lab-pre-push", clean.dir, "origin", `(delete) ${ZERO} refs/heads/old ${clean.base}\n`)).toBe(
      undefined,
    );
    const linked = lab(`Tidy ${T}#3`);
    linked.git("push", "-q", "origin", "main");
    expect(check("lab-pre-push", linked.dir, "origin", update(linked.head, linked.head))).toBeUndefined();
  });

  it("still reads the commits when the remote's old commit isn't here", () => {
    const { dir, head } = lab(`Tidy ${T}#3`);
    expect(check("lab-pre-push", dir, "origin", update(head, "1".repeat(40)))?.reasons).toEqual([LINK_REASON]);
  });

  it("doesn't apply the reviewed repo's word list to the lab", () => {
    const { dir, base, head } = lab("Record the planted bug's answer key");
    expect(check("lab-pre-push", dir, "origin", update(head, base))).toBeUndefined();
  });
});
