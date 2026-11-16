/**
 * The lab's own git hooks (re-grade 5): links go one way, so a lab commit message may name target work as plain
 * text, never link a reviewed repo's issue or PR. git runs these for every commit and push, whatever started it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempRepo } from "./fixtures.ts";
import { check, LINK_REASON, OTHER_REMOTE, PRIVATE_ID, REVIEWED_REMOTE } from "./git-guard.ts";

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

describe("the lab's commit-msg hook refuses target links", () => {
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

describe("the lab's pre-push hook refuses target links in the commits it sends", () => {
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

describe("the lab's pre-push asks the remote what it has (Qodo on PR 329)", () => {
  it("isn't fooled by a local remote-tracking ref moved onto the linked commit", () => {
    const { dir, git, head } = lab(`Tidy ${T}#3`);
    git("update-ref", "refs/remotes/origin/cover", head);
    expect(check("lab-pre-push", dir, "origin", update(head, ZERO, "refs/heads/new"))?.reasons).toEqual([LINK_REASON]);
  });

  it("reads only the new commits when the push names the remote by URL", () => {
    const clean = lab("Tidy for target 3");
    const url = clean.git("remote", "get-url", "origin").trim();
    expect(check("lab-pre-push", clean.dir, url, update(clean.head, ZERO, "refs/heads/new"))).toBeUndefined();
    // An old commit the remote already holds, with a link in it, doesn't block a later clean push.
    const old = lab(`Tidy ${T}#3`);
    old.git("push", "-q", "origin", "main");
    writeFileSync(join(old.dir, "b.md"), "Two\n");
    old.git("add", "b.md");
    old.git("commit", "-q", "-m", "Tidy more");
    const next = old.git("rev-parse", "HEAD").trim();
    const oldUrl = old.git("remote", "get-url", "origin").trim();
    expect(check("lab-pre-push", old.dir, oldUrl, update(next, ZERO, "refs/heads/new"))).toBeUndefined();
  });
});

describe("the lab's history never goes to a reviewed repo", () => {
  it.each([`https://github.com/${T}.git`, `git@github.com:${T}.git`, `ssh://git@ssh.github.com:443/${T}`])(
    "refuses a push to %s",
    (url) => {
      const { dir, base, head } = lab("Tidy for target 3");
      expect(check("lab-pre-push", dir, "t", update(head, base), url)?.reasons).toEqual([REVIEWED_REMOTE]);
    },
  );

  it("refuses a push to a local checkout of a reviewed repo", () => {
    const target = tempRepo();
    target.git("remote", "add", "origin", `https://github.com/${T}.git`);
    const { dir, base, head } = lab("Tidy for target 3");
    expect(check("lab-pre-push", dir, target.dir, update(head, base), target.dir)?.reasons).toEqual([REVIEWED_REMOTE]);
  });

  it("still lets a push go to the lab's own remote", () => {
    const { dir, git, base, head } = lab("Tidy for target 3");
    const url = git("remote", "get-url", "origin").trim();
    expect(check("lab-pre-push", dir, "origin", update(head, base), url)).toBeUndefined();
  });
});

describe("a lab commit may not name a private template", () => {
  const priv = mkdtempSync(join(tmpdir(), "git-guard-private6-"));
  mkdirSync(join(priv, "templates", "x-secret-v1"), { recursive: true });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["Notes for x-secret-v1\n", "Notes for 1v-terces-x\n", "Notes for X_SECRET_V1\n"])(
    "refuses the commit message %j",
    (message) => {
      vi.stubEnv("FAULTFORGE_PRIVATE_DIR", priv);
      const { dir } = tempRepo();
      const file = join(dir, "MSG");
      writeFileSync(file, message);
      expect(check("lab-commit-msg", dir, file)?.reasons).toEqual([PRIVATE_ID]);
    },
  );

  it("refuses a pushed commit whose message names one", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", priv);
    const { dir, base, head } = lab("Notes for x-secret-v1");
    expect(check("lab-pre-push", dir, "origin", update(head, base))?.reasons).toEqual([PRIVATE_ID]);
  });

  it("still allows a message that names no private template", () => {
    vi.stubEnv("FAULTFORGE_PRIVATE_DIR", priv);
    const { dir } = tempRepo();
    const file = join(dir, "MSG");
    writeFileSync(file, "Tidy the notes\n");
    expect(check("lab-commit-msg", dir, file)).toBeUndefined();
  });
});

describe("the private checkout's history goes only to its recorded origin", () => {
  const ORIGIN = "https://github.com/AJBeumer/x-private.git";
  function priv(recorded = true) {
    const repo = tempRepo();
    if (recorded) repo.git("config", "review-guard.origin", ORIGIN);
    return repo;
  }

  it("allows the recorded origin, in any spelling of the same repo", () => {
    const { dir } = priv();
    expect(check("private-pre-push", dir, "origin", "", ORIGIN)).toBeUndefined();
    expect(check("private-pre-push", dir, "x", "", "git@github.com:AJBeumer/x-private.git")).toBeUndefined();
  });

  it.each([
    "https://github.com/AJBeumer/faultforge.git",
    `https://github.com/${T}.git`,
    "D:/somewhere/else.git",
    "https://gitlab.com/AJBeumer/x-private.git",
  ])("refuses a push to %s", (url) => {
    const { dir } = priv();
    expect(check("private-pre-push", dir, "lab", "", url)?.reasons).toEqual([OTHER_REMOTE]);
  });

  it("refuses everything when no origin was recorded", () => {
    const { dir } = priv(false);
    expect(check("private-pre-push", dir, "origin", "", ORIGIN)?.reasons).toEqual([OTHER_REMOTE]);
  });
});
