/**
 * What `review:gate` found in each saved review last time, so a commit parses only new or changed files.
 * The evidence folder only grows, and the gate runs in a hook with a time limit.
 *
 * The cache lives in the checkout's `node_modules/.cache/`, never a shared temp folder another user could
 * fill first. An entry is used only while its file, and any `split.json` beside it, keep the same size and
 * times. The cache is tied to the source of the code that reads reviews, so a change to that code never gets
 * an older reading. A cache that can't be read or written only costs speed, never changes the answer.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256 } from "../shared/provenance.ts";
import type { ReviewRecord } from "./review-gate-records.ts";

/** What a saved file held when last read: a review record, or nothing usable (not a review, not JSON). */
interface Entry {
  stamp: string;
  record: ReviewRecord | null;
}

/** A change to this file or the reader starts the cache afresh. */
function codeVersion(): string {
  return sha256(
    Buffer.concat(
      ["review-gate-cache.ts", "review-gate-records.ts"].map((f) => readFileSync(join(import.meta.dirname, f))),
    ),
  );
}

export function stampOf(stat: Pick<Stats, "size" | "mtimeMs" | "ctimeMs">): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** The `split.json` beside a review: its stamp, "none" when there is none, or null when it can't be told. */
export function sidecarStamp(path: string): string | null {
  try {
    return stampOf(statSync(path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : null;
  }
}

/** Where the cache for an evidence folder lives, inside the checkout `checkout`. */
export function defaultCacheFile(root: string, checkout: string): string {
  const id = sha256(resolve(root)).slice(0, 16);
  return join(checkout, "node_modules", ".cache", "review-gate", `${id}.json`);
}

export class ReviewCache {
  private readonly old = new Map<string, Entry>();
  private readonly next = new Map<string, Entry>();
  private changed = false;

  private constructor(
    private readonly file: string | null,
    private readonly version: string,
  ) {}

  /** The cache in `file`, or an empty one when it is missing, unreadable, or from other code. */
  static load(file: string, version: string = codeVersion()): ReviewCache {
    const cache = new ReviewCache(file, version);
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; entries?: unknown };
      if (doc.version === version && doc.entries && typeof doc.entries === "object")
        for (const [path, entry] of Object.entries(doc.entries as Record<string, unknown>))
          if (isEntry(entry)) cache.old.set(path, entry);
    } catch {
      // No cache, or not one this code can trust: parse everything.
    }
    return cache;
  }

  /** The record last read from `path`, when its stamp still matches; undefined means read it. */
  get(path: string, stamp: string | null): { record: ReviewRecord | null } | undefined {
    const entry = stamp === null ? undefined : this.old.get(path);
    if (!entry || entry.stamp !== stamp) return undefined;
    this.next.set(path, entry);
    return { record: entry.record };
  }

  /** What `path` held, read just now. A null stamp is never kept: the file can't be told apart later. */
  set(path: string, stamp: string | null, record: ReviewRecord | null): void {
    this.changed = true;
    if (stamp !== null) this.next.set(path, { stamp, record });
  }

  /** Writes what this run saw, if anything changed, dropping files that are gone. Never throws. */
  save(): void {
    if (!this.file || (!this.changed && this.next.size === this.old.size)) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: this.version, entries: Object.fromEntries(this.next) }));
      renameSync(tmp, this.file);
    } catch {
      // Only speed is lost; the next run reads everything again.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // A leftover temp file is harmless: it is never read.
      }
    }
  }
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const { stamp, record } = value as Record<string, unknown>;
  if (typeof stamp !== "string") return false;
  if (record === null) return true;
  const r = record as Record<string, unknown> | undefined;
  return (
    !!r &&
    typeof r === "object" &&
    Array.isArray(r.trees) &&
    r.trees.every((t) => typeof t === "string") &&
    typeof r.source === "string" &&
    (typeof r.baseSha === "string" || r.baseSha === null) &&
    (typeof r.repo === "string" || r.repo === null) &&
    (r.incompleteBecause === undefined || typeof r.incompleteBecause === "string") &&
    typeof r.complete === "boolean" &&
    typeof r.skipped === "boolean" &&
    typeof r.at === "number"
  );
}
