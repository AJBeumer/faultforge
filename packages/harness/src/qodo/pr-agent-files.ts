/**
 * The file-based Qodo configuration that Qodo's API doesn't report: a repository's root `.pr_agent.toml` and its
 * Wiki page `.pr_agent.toml`. Qodo's docs rank both above any portal setting, and anyone who can edit the Wiki
 * can change a review without a commit (configuration v13 was such a page). `qodo:check` reads both for every
 * repository in `factory.json` and compares them with the snapshot's `pr-agent-files.json`.
 *
 * A file that isn't there is recorded as `text: null`. The Wiki counts as empty when GitHub says it is off, or
 * when the repository has a Wiki but no page yet (a clone then answers "Repository not found"). Anything else
 * that keeps a file from being read throws, so the check can't read a failure as "absent".
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalCallError, gh, ghJson, runExternal } from "../shared/github.ts";
import type { Difference } from "./qodo-check.ts";

export type Place = "root" | "wiki";

export interface PrAgentFile {
  repo: string;
  place: Place;
  /** The file's text, or null when it doesn't exist. */
  text: string | null;
}

export interface FileReaders {
  /** The root `.pr_agent.toml` on the default branch, or null when there is none. */
  root(repo: string): string | null;
  /** The Wiki page `.pr_agent.toml`, or null when the Wiki is off, empty, or has no such page. */
  wiki(repo: string): string | null;
}

/** Both files for every repository, in a fixed order. */
export function readPrAgentFiles(repos: string[], readers: FileReaders): PrAgentFile[] {
  return repos.flatMap((repo) => [
    { repo, place: "root" as const, text: readers.root(repo) },
    { repo, place: "wiki" as const, text: readers.wiki(repo) },
  ]);
}

/** A file's text, from a snapshot or live; a repository and place the snapshot has no record of count as absent. */
function textById(files: PrAgentFile[]): Map<string, string | null> {
  return new Map(files.map((f) => [`${f.repo} ${f.place}`, f.text]));
}

/** "new" when a file appeared, "missing" when one went, "changed" when its text differs. */
export function comparePrAgentFiles(live: PrAgentFile[], snapshot: PrAgentFile[]): Difference[] {
  const before = textById(snapshot);
  const after = textById(live);
  const differences: Difference[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(id) ?? null;
    const is = after.get(id) ?? null;
    const name = `${id} .pr_agent.toml`;
    if (was === null && is !== null) differences.push({ kind: "file", type: "new", id, name });
    else if (was !== null && is === null) differences.push({ kind: "file", type: "missing", id, name });
    else if (was !== is)
      differences.push({ kind: "file", type: "changed", id, name, field: "text", before: was, after: is });
  }
  return differences;
}

/** A Wiki page's file is its title plus a markup extension: `.pr_agent.toml.md` for a Markdown page. */
export function wikiPage(names: string[]): string | undefined {
  return names.find((name) => name.replace(/\.[^.]+$/, "") === ".pr_agent.toml");
}

/** A clone of a Wiki has its own, longer limit than an ordinary call. */
const CLONE_TIMEOUT_MS = 120_000;

/** The outside calls the readers make, handed in so a test can answer them. */
export interface ReaderCalls {
  /** The root file's raw text; throws `ExternalCallError` (404 in its stderr when there is none). */
  rootText(repo: string): string;
  repoInfo(repo: string): { has_wiki?: boolean; private?: boolean };
  /** Clones the Wiki into `dir`; throws `ExternalCallError` on failure. */
  cloneWiki(repo: string, dir: string): void;
}

const realCalls: ReaderCalls = {
  rootText: (repo) => gh("api", `repos/${repo}/contents/.pr_agent.toml`, "-H", "Accept: application/vnd.github.raw"),
  repoInfo: (repo) => ghJson("api", `repos/${repo}`),
  cloneWiki: (repo, dir) => {
    runExternal(
      "git clone",
      "git",
      ["clone", "-q", "--depth", "1", `https://github.com/${repo}.wiki.git`, dir],
      CLONE_TIMEOUT_MS,
    );
  },
};

const said = (error: unknown, pattern: RegExp) => error instanceof ExternalCallError && pattern.test(error.stderr);

export function makeReaders(calls: ReaderCalls): FileReaders {
  return {
    root(repo) {
      try {
        return calls.rootText(repo);
      } catch (error) {
        if (said(error, /HTTP 404/)) return null;
        throw error;
      }
    },
    wiki(repo) {
      const info = calls.repoInfo(repo);
      if (info.has_wiki !== true) return null;
      // Without credentials a private repository's Wiki also answers "not found", which would read as empty.
      if (info.private !== false)
        throw new Error(`${repo} is not public, so its Wiki can't be read without credentials`);
      const dir = mkdtempSync(join(tmpdir(), "qodo-wiki-"));
      try {
        try {
          calls.cloneWiki(repo, dir);
        } catch (error) {
          if (said(error, /Repository not found/i)) return null;
          throw error;
        }
        const page = wikiPage(readdirSync(dir));
        return page === undefined ? null : readFileSync(join(dir, page), "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export const realReaders: FileReaders = makeReaders(realCalls);
