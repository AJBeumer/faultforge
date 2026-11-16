import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Reviewed } from "../../../.claude/hooks/shared/repos.ts";
import { type Gh, main } from "./target-post.ts";
import type { Git } from "./target-post-push.ts";

const DIR = mkdtempSync(join(tmpdir(), "target-post-"));
const PRIVATE = join(DIR, "private");
mkdirSync(join(PRIVATE, "templates", "x-secret-v1"), { recursive: true });
const ENV = { ...process.env, FAULTFORGE_PRIVATE_DIR: PRIVATE, FAULTFORGE_GUARD_PRIVATE_DIR: PRIVATE };
const CHECKOUT = join(DIR, "app");

/** The reviewed repos, as the guard reads them from factory.json. */
const APP: Reviewed = { github: "Owner/app", name: "app", folder: "app", checkout: CHECKOUT };
const OTHER: Reviewed = { github: "Owner/other", name: "other", folder: "other", checkout: join(DIR, "other") };
let REVIEWED: Reviewed[] = [APP];

let files = 0;
/** A text file with `text`, its path. */
function file(text: string | Buffer): string {
  const path = join(DIR, `text-${files++}.md`);
  writeFileSync(path, text);
  return path;
}

/** A fake gh that records each call and its stdin, and prints `out`. */
function fakeGh(out = "https://github.com/Owner/app/issues/7\n") {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: Gh = (args, input) => {
    calls.push({ args, input });
    return out;
  };
  return { gh, calls };
}

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

/**
 * A fake git for a checkout whose origin is `url`, with branch `tidy` at SHA, one commit the remote lacks (SHA, with
 * `message`), changing `changed` (a null content is a deletion). The remote's `main` is at BASE_SHA. Records every
 * call.
 */
function fakeGit(
  message = "Tidy the lookup\n",
  changed: Record<string, string | null> = { "src/a.ts": "export {};\n" },
) {
  const calls: string[][] = [];
  let url = "https://github.com/Owner/app.git";
  let rewrites = "";
  const git: Git = (_cwd, args) => {
    calls.push(args);
    const a = args.join(" ");
    if (a.startsWith("remote get-url")) return `${url}\n`;
    if (a.startsWith("config --get-regexp")) {
      if (!rewrites) throw new Error("exit 1");
      return rewrites;
    }
    if (a.startsWith("ls-remote")) return `${BASE_SHA}\trefs/heads/main\n`;
    if (a.startsWith("rev-parse")) return `${SHA}\n`;
    if (a.startsWith("rev-list")) return `${SHA}\n`;
    if (a.startsWith("log -1")) return `Ann <ann@example.com>\nAnn <ann@example.com>\n${message}`;
    if (a.startsWith("diff-tree")) {
      return Object.entries(changed)
        .map(([path, text]) => `${text === null ? "D" : "M"}\0${path}\0`)
        .join("");
    }
    if (a.startsWith("cat-file blob")) {
      const path = (args[2] ?? "").slice(SHA.length + 1);
      const text = changed[path];
      if (text === undefined || text === null) throw new Error("no such blob");
      return text;
    }
    if (a.startsWith("push")) return "";
    throw new Error(`unexpected git ${a}`);
  };
  return { git, calls, setUrl: (u: string) => (url = u), setRewrites: (r: string) => (rewrites = r) };
}

function run(argv: string[], deps: { gh?: Gh; git?: Git } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    ...deps,
    env: ENV,
    reviewed: REVIEWED,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("target:post, the one door to the reviewed repository (#340)", () => {
  it("creates an issue from files, sending the body it checked on stdin", () => {
    const fake = fakeGh();
    const { code, out } = run(
      ["issue-create", "--title-file", file("Add a booking note\n"), "--body-file", file("### What\nA note.\n")],
      { gh: fake.gh },
    );
    expect(code).toBe(0);
    expect(out).toContain("/issues/7");
    expect(fake.calls).toEqual([
      {
        args: [
          "issue",
          "create",
          "--repo",
          "github.com/Owner/app",
          "--title",
          "Add a booking note",
          "--body-file",
          "-",
        ],
        input: "### What\nA note.\n",
      },
    ]);
  });

  const KINDS: [string, string[], string[]][] = [
    ["issue-edit", ["--number", "3"], ["issue", "edit", "3", "--repo", "github.com/Owner/app"]],
    ["issue-comment", ["--number", "3"], ["issue", "comment", "3", "--repo", "github.com/Owner/app"]],
    [
      "pr-create",
      ["--head", "tidy"],
      ["pr", "create", "--repo", "github.com/Owner/app", "--base", "main", "--head", "tidy"],
    ],
    ["pr-edit", ["--number", "4"], ["pr", "edit", "4", "--repo", "github.com/Owner/app"]],
    ["pr-comment", ["--number", "4"], ["pr", "comment", "4", "--repo", "github.com/Owner/app"]],
    ["pr-close", ["--number", "4"], ["pr", "close", "4", "--repo", "github.com/Owner/app"]],
  ];

  for (const [kind, options, start] of KINDS) {
    const withTitle = ["issue-edit", "pr-create", "pr-edit"].includes(kind);
    const titled = (title: string) => (withTitle ? ["--title-file", file(title)] : []);

    it(`${kind}: sends clean text with gh`, () => {
      const fake = fakeGh();
      const { code } = run([kind, ...options, ...titled("Tidy up"), "--body-file", file("Plain words.")], {
        gh: fake.gh,
      });
      expect(code).toBe(0);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.args.slice(0, start.length)).toEqual(start);
      const sent = `${fake.calls[0]?.input ?? ""}${fake.calls[0]?.args.join(" ")}`;
      expect(sent).toContain("Plain words.");
    });

    it(`${kind}: refuses a body that names the lab, a private template or Qodo, with exit 2 and sends nothing`, () => {
      for (const body of [
        "Seen in the Fault<!-- -->Forge lab",
        "Follows x-s3cret-v1.",
        "@qodo please look",
        "pl4nted",
      ]) {
        const fake = fakeGh();
        const { code, err } = run([kind, ...options, ...titled("Tidy up"), "--body-file", file(body)], {
          gh: fake.gh,
        });
        expect(code, body).toBe(2);
        expect(err).toMatch(/refused/);
        expect(err).not.toContain("x-s3cret-v1");
        expect(fake.calls).toEqual([]);
      }
    });

    if (withTitle) {
      it(`${kind}: refuses a title that gives the case away`, () => {
        const fake = fakeGh();
        const { code, err } = run([kind, ...options, ...titled("Fix FF-9001"), "--body-file", file("ok")], {
          gh: fake.gh,
        });
        expect(code).toBe(2);
        expect(err).toMatch(/title: contains a case id/);
        expect(fake.calls).toEqual([]);
      });
    }
  }

  it("pr-create refuses a head branch that gives the case away", () => {
    const fake = fakeGh();
    const { code, err } = run(
      ["pr-create", "--head", "sabotage-x", "--title-file", file("Tidy"), "--body-file", file("ok")],
      { gh: fake.gh },
    );
    expect(code).toBe(2);
    expect(err).toMatch(/head branch: says sabotage/);
    expect(fake.calls).toEqual([]);
  });

  it("exits 3 when gh fails after the checks pass", () => {
    const gh: Gh = () => {
      throw new Error("HTTP 502");
    };
    const { code, err } = run(["issue-comment", "--number", "1", "--body-file", file("ok")], { gh });
    expect(code).toBe(3);
    expect(err).toMatch(/may have landed/);
  });

  it("exits 1 for usage: an unknown kind, a missing file, a two-line title, a repo that isn't reviewed", () => {
    const gh = fakeGh();
    expect(run(["issue-merge"], { gh: gh.gh }).code).toBe(1);
    expect(run(["issue-comment", "--number", "1", "--body-file", join(DIR, "none.md")], { gh: gh.gh }).code).toBe(1);
    expect(run(["issue-create", "--title-file", file("one\ntwo"), "--body-file", file("ok")], { gh: gh.gh }).code).toBe(
      1,
    );
    expect(
      run(["issue-comment", "--repo", "Owner/lab", "--number", "1", "--body-file", file("ok")], { gh: gh.gh }).code,
    ).toBe(1);
    expect(run(["issue-comment", "--number", "1", "--body-file", file(Buffer.from([0xff, 0xfe]))], gh).code).toBe(1);
    expect(run(["pr-comment", "--number", "1", "--title-file", file("x"), "--body-file", file("ok")], gh).code).toBe(1);
    expect(gh.calls).toEqual([]);
  });

  describe("push", () => {
    it("pushes the commit it read, to the URL it checked, never forced", () => {
      const fake = fakeGit();
      const { code } = run(["push", "--branch", "tidy"], { git: fake.git });
      expect(code).toBe(0);
      expect(fake.calls.at(-1)).toEqual([
        "push",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "https://github.com/Owner/app.git",
        `${SHA}:refs/heads/tidy`,
      ]);
    });

    it("refuses a commit message, a file's content or a file's path that gives the case away", () => {
      const cases: ReturnType<typeof fakeGit>[] = [
        fakeGit("Plant the bug\n\nThe planted bug for the lab\n"),
        fakeGit("Tidy\n", { "src/a.ts": "// answer key: line 3\n" }),
        fakeGit("Tidy\n", { "test/ledger.test.ts": "ok\n" }),
        fakeGit("Tidy\n", { "docs/x.md": "see x-secret-v1\n" }),
      ];
      for (const fake of cases) {
        const { code, err } = run(["push", "--branch", "tidy"], { git: fake.git });
        expect(code).toBe(2);
        expect(err).toMatch(/refused/);
        expect(fake.calls.some((c) => c[0] === "push")).toBe(false);
      }
    });

    it("refuses a branch name that gives the case away or isn't plain, before reading git", () => {
      for (const branch of ["ff-0012-fix", "-f", "a..b", "x/"]) {
        const fake = fakeGit();
        expect(run(["push", `--branch=${branch}`], { git: fake.git }).code).toBe(2);
        expect(fake.calls.some((c) => c[0] === "push")).toBe(false);
      }
    });

    it("refuses when origin points anywhere but the reviewed repo, or a file can't be read", () => {
      const elsewhere = fakeGit();
      elsewhere.setUrl("https://github.com/Owner/other.git");
      expect(run(["push", "--branch", "tidy"], { git: elsewhere.git }).code).toBe(2);
      const unreadable = fakeGit();
      const git: Git = (cwd, args) => {
        if (args[0] === "cat-file") throw new Error("submodule");
        return unreadable.git(cwd, args);
      };
      expect(run(["push", "--branch", "tidy"], { git }).code).toBe(2);
      expect(unreadable.calls.some((c) => c[0] === "push")).toBe(false);
    });

    it("exits 3 when git push itself fails", () => {
      const fake = fakeGit();
      const git: Git = (cwd, args) => {
        if (args[0] === "push") throw new Error("rejected: non-fast-forward");
        return fake.git(cwd, args);
      };
      expect(run(["push", "--branch", "tidy"], { git }).code).toBe(3);
    });

    it("checks every commit the remote itself doesn't have, never trusting local remote-tracking refs", () => {
      const fake = fakeGit();
      run(["push", "--branch", "tidy"], { git: fake.git });
      expect(fake.calls).toContainEqual(["ls-remote", "https://github.com/Owner/app.git"]);
      expect(fake.calls).toContainEqual(["rev-list", "--ignore-missing", SHA, "--not", BASE_SHA]);
      expect(fake.calls.some((c) => c.some((w) => w.includes("--remotes")))).toBe(false);
    });

    it("refuses a deleted file whose path gives the case away (the diff shows its name)", () => {
      const fake = fakeGit("Tidy\n", { "docs/planted-bugs.md": null });
      const { code, err } = run(["push", "--branch", "tidy"], { git: fake.git });
      expect(code).toBe(2);
      expect(err).toMatch(/path in .*: says planted/);
      expect(fake.calls.some((c) => c[0] === "cat-file")).toBe(false);
    });

    it("refuses an origin on another host that only mentions github.com, and a git URL rewrite", () => {
      for (const url of [
        "https://evil.example//github.com/Owner/app",
        "https://evil.example/github.com/Owner/app.git",
        "git@evil.example:github.com/Owner/app.git",
      ]) {
        const fake = fakeGit();
        fake.setUrl(url);
        expect(run(["push", "--branch", "tidy"], { git: fake.git }).code, url).toBe(2);
        expect(fake.calls.some((c) => c[0] === "push")).toBe(false);
      }
      const rewritten = fakeGit();
      rewritten.setRewrites("url.https://evil.example/.pushinsteadof https://github.com/\n");
      expect(run(["push", "--branch", "tidy"], { git: rewritten.git }).code).toBe(2);
      expect(rewritten.calls.some((c) => c[0] === "push")).toBe(false);
    });

    it("takes GitHub's own remote spellings", () => {
      for (const url of ["git@github.com:Owner/app.git", "ssh://git@ssh.github.com:443/Owner/app.git"]) {
        const fake = fakeGit();
        fake.setUrl(url);
        expect(run(["push", "--branch", "tidy"], { git: fake.git }).code, url).toBe(0);
      }
    });
  });

  it("pr-create refuses a head from a fork (owner:branch), whose commits never went through the door", () => {
    const fake = fakeGh();
    const { code } = run(
      ["pr-create", "--head", "someone:tidy", "--title-file", file("Tidy"), "--body-file", file("ok")],
      {
        gh: fake.gh,
      },
    );
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
  });

  it("asks for --repo when there is more than one reviewed repo, and never picks one itself (Qodo on PR 344)", () => {
    REVIEWED = [APP, OTHER];
    try {
      const fake = fakeGh();
      expect(run(["issue-comment", "--number", "2", "--body-file", file("ok")], { gh: fake.gh }).code).toBe(1);
      expect(
        run(["issue-comment", "--repo", "Owner/other", "--number", "2", "--body-file", file("ok")], fake).code,
      ).toBe(0);
      expect(fake.calls[0]?.args).toContain("github.com/Owner/other");
    } finally {
      REVIEWED = [APP];
    }
  });

  it("names github.com in --repo, so GH_HOST can't send the post to another host", () => {
    const fake = fakeGh();
    run(["issue-comment", "--number", "2", "--body-file", file("ok")], { gh: fake.gh });
    expect(fake.calls[0]?.args).toContain("github.com/Owner/app");
  });
});
