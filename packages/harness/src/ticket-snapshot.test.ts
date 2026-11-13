import { describe, expect, it } from "vitest";
import { buildSnapshot, provenanceProblems, type SnapshotField, ticketChangeProblems } from "./ticket-snapshot.ts";

describe("buildSnapshot: GitHub's pages", () => {
  const who = (login: string) => ({ login });
  const comment = (author: string, at: string, editors: string[] = [], total = editors.length) => ({
    author: who(author),
    body: `text by ${author}`,
    createdAt: at,
    userContentEdits: { totalCount: total, nodes: editors.map((e) => ({ editor: who(e) })) },
  });
  /** A fake GitHub: each field's pages, keyed by the cursor that leads to them ("" for the first). */
  const github = (pages: Record<string, Record<string, { nodes: unknown[]; next: string | null }>>) => {
    const asked: string[] = [];
    const fetch = (field: SnapshotField, cursor: string | null) => {
      asked.push(`${field}@${cursor ?? ""}`);
      // No renames unless a test gives some.
      const none = field === "timelineItems" && !pages[field] && !cursor ? { nodes: [], next: null } : undefined;
      const page = pages[field]?.[cursor ?? ""] ?? none;
      if (!page) throw new Error(`no page ${field}@${cursor}`);
      return {
        title: "Filter",
        body: "body",
        author: who("owner"),
        [field]: { pageInfo: { hasNextPage: page.next !== null, endCursor: page.next }, nodes: page.nodes },
      };
    };
    return { fetch, asked };
  };

  it("follows every page, so a stranger on the last page is still seen", () => {
    const { fetch, asked } = github({
      userContentEdits: {
        "": { nodes: [{ editor: who("owner") }], next: "e1" },
        e1: { nodes: [{ editor: who("owner") }], next: "e2" },
        e2: { nodes: [{ editor: who("mallory") }], next: null },
      },
      comments: {
        "": { nodes: [comment("owner", "2026-11-09T08:00:00Z")], next: "c1" },
        c1: { nodes: [comment("eve", "2026-11-09T08:05:00Z")], next: null },
      },
    });
    const snapshot = buildSnapshot(fetch);
    expect(asked).toEqual([
      "userContentEdits@",
      "userContentEdits@e1",
      "userContentEdits@e2",
      "comments@",
      "comments@c1",
      "timelineItems@",
    ]);
    expect(snapshot.provenance.editors).toEqual(["owner", "owner", "mallory"]);
    expect(provenanceProblems(snapshot.provenance, "owner")).toEqual(["edited by mallory", "commented on by eve"]);
    expect(snapshot.text).toContain("Comment by eve, 2026-11-09T08:05:00Z:\n\ntext by eve");
  });

  it("refuses a ticket someone else renamed, and accepts the owner's own renames (#215)", () => {
    const pages = (renamers: string[]) =>
      github({
        userContentEdits: { "": { nodes: [], next: null } },
        comments: { "": { nodes: [], next: null } },
        timelineItems: { "": { nodes: renamers.map((r) => ({ actor: who(r) })), next: null } },
      }).fetch;
    expect(provenanceProblems(buildSnapshot(pages(["owner"])).provenance, "owner")).toEqual([]);
    expect(provenanceProblems(buildSnapshot(pages(["owner", "mallory"])).provenance, "owner")).toEqual([
      "renamed by mallory",
    ]);
  });

  it("stops with an error when GitHub repeats a cursor, never with a short answer", () => {
    const { fetch } = github({
      userContentEdits: { "": { nodes: [], next: "same" }, same: { nodes: [], next: "same" } },
      comments: { "": { nodes: [], next: null } },
    });
    expect(() => buildSnapshot(fetch)).toThrow(/repeated the userContentEdits cursor/);
  });

  it("reports a comment with more edits than one page as not fully readable", () => {
    const { fetch } = github({
      userContentEdits: { "": { nodes: [], next: null } },
      comments: { "": { nodes: [comment("owner", "2026-11-09T08:00:00Z", ["owner"], 150)], next: null } },
    });
    expect(provenanceProblems(buildSnapshot(fetch).provenance, "owner")).toEqual([
      "not fully readable: the edits of a comment from 2026-11-09T08:00:00Z",
    ]);
  });

  it("catches an edit that was undone: same text, same authors, longer history", () => {
    const before = buildSnapshot(
      github({
        userContentEdits: { "": { nodes: [], next: null } },
        comments: { "": { nodes: [comment("owner", "2026-11-09T08:00:00Z")], next: null } },
      }).fetch,
    );
    const after = buildSnapshot(
      github({
        userContentEdits: { "": { nodes: [], next: null } },
        comments: { "": { nodes: [comment("owner", "2026-11-09T08:00:00Z", ["owner", "owner"])], next: null } },
      }).fetch,
    );
    expect(after.text).toBe(before.text);
    expect(ticketChangeProblems(before, after, "owner")).toEqual([
      "the ticket was edited during the run, even though its text is back as it was",
    ]);
  });
});
