import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brokenLinks,
  type MarkdownFile,
  markdownFiles,
  markdownProblems,
  slugs,
  structureProblems,
  tooLong,
  unlistedDocs,
} from "./docs-check-structure.ts";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const file = (path: string, text: string): MarkdownFile => ({ path, text });

describe("tooLong: no page over 150 lines (#354)", () => {
  it("refuses a long page under docs/, at the root, or in .claude/skills/", () => {
    const files = [
      file("docs/charter/a.md", lines(151)),
      file("CLAUDE.md", lines(151)),
      file(".claude/skills/x/SKILL.md", lines(151)),
    ];
    expect(tooLong(files)).toEqual([
      "docs/charter/a.md: 151 lines, over the 150 a page may have",
      "CLAUDE.md: 151 lines, over the 150 a page may have",
      ".claude/skills/x/SKILL.md: 151 lines, over the 150 a page may have",
    ]);
  });

  it("allows 150 lines, a trailing newline, the decision log's weekly files, and files elsewhere", () => {
    const files = [
      file("docs/a.md", `${lines(150)}\n`),
      file("docs/decisions/week-2.md", lines(400)),
      file("packages/harness/test/README.md", lines(400)),
      file(".claude/hooks/README.md", lines(400)),
    ];
    expect(tooLong(files)).toEqual([]);
  });

  it("still holds a page in a folder below docs/decisions/ to the limit", () => {
    expect(tooLong([file("docs/decisions/old/a.md", lines(151))])).toEqual([
      "docs/decisions/old/a.md: 151 lines, over the 150 a page may have",
    ]);
  });
});

describe("slugs: GitHub's heading anchors", () => {
  it("lowercases, drops punctuation and code marks, and numbers repeats", () => {
    const text = [
      "# Decision log",
      "## Day 1: Your factory's first delivery",
      "## 13 November: corrections after a `repo` audit",
      "## Day 1: Your factory's first delivery",
      "### 15.1 Judges: three levels, no setup",
      "## See [the charter](CHARTER.md)",
      '<a id="kept"></a>',
      "```",
      "## Not a heading",
      "```",
    ].join("\n");
    expect([...slugs(text)]).toEqual([
      "decision-log",
      "day-1-your-factorys-first-delivery",
      "13-november-corrections-after-a-repo-audit",
      "day-1-your-factorys-first-delivery-1",
      "151-judges-three-levels-no-setup",
      "see-the-charter",
      "kept",
    ]);
  });
});

describe("brokenLinks: every relative link resolves (#354)", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-links-"));
  mkdirSync(join(root, "docs", "charter"), { recursive: true });
  mkdirSync(join(root, "examples"));
  writeFileSync(join(root, "examples", "case.json"), "{}\n");

  it("accepts links to files, folders and headings that exist, and skips web links and code", () => {
    const files = [
      file("README.md", "# Top\n\nSee [log](docs/log.md#day-2-rules), [case](examples/case.json), [here](#top).\n"),
      file(
        "docs/log.md",
        "# Log\n\n## Day 2: rules\n\n[up](../README.md) [folder](charter/) [web](https://x.test/a.md)\n",
      ),
      file("docs/c.md", "`[x](nowhere.md)`\n\n```\n[y](nowhere.md)\n```\n[mail](mailto:a@b.test)\n"),
    ];
    expect(brokenLinks(files, root)).toEqual([]);
  });

  it("refuses a missing file, a missing heading, and a reference link to nowhere", () => {
    const files = [
      file("README.md", "# Top\n\n[gone](docs/gone.md) [anchor](docs/log.md#no-such) [self](#nope)\n"),
      file("docs/log.md", "# Log\n\n[ref]: ../examples/missing.json\n"),
    ];
    expect(brokenLinks(files, root)).toEqual([
      "README.md: link to docs/gone.md, which doesn't exist",
      "README.md: link to docs/log.md#no-such, which has no such heading",
      "README.md: link to #nope, which has no such heading",
      "docs/log.md: link to ../examples/missing.json, which doesn't exist",
    ]);
  });
});

describe("unlistedDocs: docs/README.md links every doc (#354)", () => {
  it("names a doc under docs/ the start page doesn't link", () => {
    const files = [
      file("docs/README.md", "- [Charter](CHARTER.md)\n- [Part one](charter/01-idea.md#x)\n"),
      file("docs/CHARTER.md", ""),
      file("docs/charter/01-idea.md", ""),
      file("docs/evidence/day-06/claims.md", ""),
      file("README.md", ""),
    ];
    expect(unlistedDocs(files)).toEqual(["docs/evidence/day-06/claims.md: not linked from docs/README.md"]);
  });

  it("refuses when there is no start page at all", () => {
    expect(unlistedDocs([file("docs/a.md", "")])).toEqual(["docs/README.md: missing; it is the docs' start page"]);
  });
});

describe("markdownFiles and structureProblems on a real folder", () => {
  it("reads tracked and new Markdown files, skips ignored ones, and reports every rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "docs-structure-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", root, "init", "--quiet", "-b", "main"]);
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, ".gitignore"), "private/\n");
    writeFileSync(join(root, "README.md"), "# Lab\n\n[docs](docs/README.md)\n");
    writeFileSync(join(root, "docs", "README.md"), "# Docs\n\n[gone](gone.md)\n");
    writeFileSync(join(root, "docs", "extra.md"), `${lines(151)}\n`);
    writeFileSync(join(root, "private", "secret.md"), lines(999));
    const files = markdownFiles(root);
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "docs/README.md", "docs/extra.md"]);
    expect(structureProblems(files, root)).toEqual([
      "docs/extra.md: 151 lines, over the 150 a page may have",
      "docs/README.md: link to gone.md, which doesn't exist",
      "docs/extra.md: not linked from docs/README.md",
    ]);
  });
});

describe("Qodo on PR 357", () => {
  const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "docs-staged-"));
    git(root, "init", "--quiet", "-b", "main");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "README.md"), "# Docs\n");
    return root;
  };

  it("checks the staged copy too, since a commit records the index", () => {
    const root = repo();
    writeFileSync(join(root, "docs", "README.md"), "# Docs\n\n[gone](gone.md)\n");
    writeFileSync(join(root, "docs", "long.md"), lines(151));
    git(root, "add", ".");
    // Fixed in the working tree only: the commit would still record the staged text.
    writeFileSync(join(root, "docs", "README.md"), "# Docs\n");
    rmSync(join(root, "docs", "long.md"));
    expect(markdownProblems(root)).toEqual([
      "docs/long.md (staged): 151 lines, over the 150 a page may have",
      "docs/README.md (staged): link to gone.md, which doesn't exist",
      "docs/long.md (staged): not linked from docs/README.md",
    ]);
  });

  it("resolves a staged link against the index, not the working tree", () => {
    const root = repo();
    writeFileSync(join(root, "docs", "README.md"), "# Docs\n\n[data](data.json)\n");
    writeFileSync(join(root, "docs", "data.json"), "{}\n");
    git(root, "add", "docs/README.md");
    expect(markdownProblems(root)).toEqual(["docs/README.md (staged): link to data.json, which doesn't exist"]);
    git(root, "add", "docs/data.json");
    expect(markdownProblems(root)).toEqual([]);
  });

  it("holds a page in docs/decisions/ that isn't a weekly file to the limit", () => {
    expect(tooLong([file("docs/decisions/notes.md", lines(151))])).toEqual([
      "docs/decisions/notes.md: 151 lines, over the 150 a page may have",
    ]);
  });

  it("reads Markdown files whatever the case of their extension", () => {
    const root = repo();
    writeFileSync(join(root, "docs", "Guide.MD"), lines(151));
    expect(markdownProblems(root)).toEqual([
      "docs/Guide.MD: 151 lines, over the 150 a page may have",
      "docs/Guide.MD: not linked from docs/README.md",
    ]);
  });

  it("reads a link in angle brackets, and one with a single-quoted or bracketed title", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-links-"));
    const files = [
      file(
        "README.md",
        "[a](<missing page.md>) [b](missing.md 'title') [c](gone.md (title)) [ok](<README.md> \"t\")\n",
      ),
    ];
    expect(brokenLinks(files, root)).toEqual([
      "README.md: link to missing page.md, which doesn't exist",
      "README.md: link to missing.md, which doesn't exist",
      "README.md: link to gone.md, which doesn't exist",
    ]);
  });
});
