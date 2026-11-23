import { describe, expect, it } from "vitest";
import { ExternalCallError } from "../shared/github.ts";
import {
  comparePrAgentFiles,
  makeReaders,
  type PrAgentFile,
  type ReaderCalls,
  readPrAgentFiles,
  wikiPage,
} from "./pr-agent-files.ts";

const failed = (stderr: string) => new ExternalCallError("call", { stderr });
const TOML = '[review_agent]\nissues_user_guidelines = "fail closed"\n';

function calls(over: Partial<ReaderCalls> = {}): ReaderCalls {
  return {
    rootText: () => {
      throw failed("gh: Not Found (HTTP 404)");
    },
    repoInfo: () => ({ has_wiki: true, private: false }),
    cloneWiki: () => {},
    listWiki: () => [{ mode: "100644", name: "Home.md" }],
    showWiki: (_dir, name) => `the bytes of ${name}`,
    ...over,
  };
}

/** A Wiki holding Home.md and one page `.pr_agent.toml.md` with git's `mode`. */
const withPage = (mode: string, text = TOML) =>
  calls({
    listWiki: () => [
      { mode: "100644", name: "Home.md" },
      { mode, name: ".pr_agent.toml.md" },
    ],
    showWiki: (_dir, name) => (name === ".pr_agent.toml.md" ? text : "home\n"),
  });

describe("reading the files", () => {
  it("records a root file's text, and none on a 404", () => {
    expect(makeReaders(calls({ rootText: () => TOML })).root("o/r")).toBe(TOML);
    expect(makeReaders(calls()).root("o/r")).toBeNull();
  });

  it("throws on any other failure to read the root file, so it is never taken as absent", () => {
    const readers = makeReaders(
      calls({
        rootText: () => {
          throw failed("gh: Forbidden (HTTP 403)");
        },
      }),
    );
    expect(() => readers.root("o/r")).toThrow(/403/);
  });

  it("reads the Wiki page, and records none when the Wiki is off, empty, or has no such page", () => {
    expect(makeReaders(withPage("100644")).wiki("o/r")).toBe(TOML);
    expect(makeReaders(withPage("100755")).wiki("o/r")).toBe(TOML);
    expect(makeReaders(calls({ repoInfo: () => ({ has_wiki: false, private: false }) })).wiki("o/r")).toBeNull();
    const empty = calls({
      cloneWiki: () => {
        throw failed("remote: Repository not found.");
      },
    });
    expect(makeReaders(empty).wiki("o/r")).toBeNull();
    expect(makeReaders(calls()).wiki("o/r")).toBeNull();
  });

  it("throws when the Wiki can't be read: a network failure, or a repository that isn't public", () => {
    const network = calls({
      cloneWiki: () => {
        throw failed("fatal: unable to access: Could not resolve host: github.com");
      },
    });
    expect(() => makeReaders(network).wiki("o/r")).toThrow(/resolve host/);
    expect(() => makeReaders(calls({ repoInfo: () => ({ has_wiki: true, private: true }) })).wiki("o/r")).toThrow(
      /not public/,
    );
    expect(() => makeReaders(calls({ repoInfo: () => ({ has_wiki: true }) })).wiki("o/r")).toThrow(/not public/);
  });

  it("refuses a Wiki page committed as a link, or as anything but a plain file, and never reads it", () => {
    let read = false;
    for (const mode of ["120000", "160000", "040000"]) {
      const showWiki = () => {
        read = true;
        return "a file the link points at";
      };
      const link = { ...withPage(mode), showWiki };
      expect(() => makeReaders(link).wiki("o/r")).toThrow(/not a plain file/);
    }
    expect(read).toBe(false);
  });

  it("keeps the page's bytes as committed, line endings included", () => {
    const crlf = '[review_agent]\r\nissues_user_guidelines = "x"\r\n';
    expect(makeReaders(withPage("100644", crlf)).wiki("o/r")).toBe(crlf);
  });

  it("reads both places for every repository", () => {
    const files = readPrAgentFiles(["a/lab", "a/target"], {
      root: () => null,
      wiki: (r) => (r === "a/lab" ? TOML : null),
    });
    expect(files).toEqual([
      { repo: "a/lab", place: "root", text: null },
      { repo: "a/lab", place: "wiki", text: TOML },
      { repo: "a/target", place: "root", text: null },
      { repo: "a/target", place: "wiki", text: null },
    ]);
  });

  it("finds a Wiki page in any markup, and nothing else", () => {
    expect(wikiPage(["Home.md", ".pr_agent.toml.md"])).toBe(".pr_agent.toml.md");
    expect(wikiPage([".pr_agent.toml.textile"])).toBe(".pr_agent.toml.textile");
    expect(wikiPage(["Home.md", "pr_agent.toml.md", ".pr_agent.toml.old.md"])).toBeUndefined();
  });
});

describe("comparing with the snapshot", () => {
  const file = (place: "root" | "wiki", text: string | null): PrAgentFile => ({ repo: "a/lab", place, text });

  it("finds nothing when both agree, including on absent files", () => {
    expect(
      comparePrAgentFiles([file("root", null), file("wiki", TOML)], [file("root", null), file("wiki", TOML)]),
    ).toEqual([]);
  });

  it("reports a page that appeared, one that went, and one that changed", () => {
    expect(comparePrAgentFiles([file("wiki", TOML)], [file("wiki", null)])).toEqual([
      { kind: "file", type: "new", id: "a/lab wiki", name: "a/lab wiki .pr_agent.toml" },
    ]);
    expect(comparePrAgentFiles([file("wiki", null)], [file("wiki", TOML)])[0]?.type).toBe("missing");
    expect(comparePrAgentFiles([file("root", "b")], [file("root", "a")])[0]).toEqual(
      expect.objectContaining({ type: "changed", field: "text", before: "a", after: "b" }),
    );
  });

  // Proof test for the review finding "Incomplete snapshots pass the check" (certificate issued).
  it("reports a file the snapshot holds no record of, even an absent one", () => {
    expect(comparePrAgentFiles([file("root", null)], [])).toEqual([
      {
        kind: "file",
        type: "changed",
        id: "a/lab root",
        name: "a/lab root .pr_agent.toml",
        field: "record",
        before: "no record",
        after: null,
      },
    ]);
    expect(comparePrAgentFiles([file("root", TOML)], [])[0]).toEqual(expect.objectContaining({ after: TOML }));
  });
});
