import { describe, expect, it } from "vitest";
import { type QodoReview, ticketsCited } from "./qodo-review.ts";

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const TICKET = "https://github.com/Owner/repo/issues/7";
const OTHER_TICKET = "https://github.com/Owner/repo/issues/9";

type RawFinding = NonNullable<QodoReview["findings"]>[0];
const cite = (source_type: string, source: string) => ({ source_type, source });
const finding = (id: string, git_sha: string, ...citations: ReturnType<typeof cite>[]): RawFinding => ({
  id,
  git_sha,
  evidence: { citations },
});

describe("ticketsCited", () => {
  it("lists each ticket cited on the commit once, in first-seen order", () => {
    const review: QodoReview = {
      findings: [
        finding("1", HEAD, cite("pr_branch_file", "src/a.ts[1-2]"), cite("ticket", TICKET)),
        finding("2", HEAD, cite("ticket", OTHER_TICKET), cite("ticket", TICKET)),
      ],
    };
    expect(ticketsCited(review, HEAD)).toEqual([TICKET, OTHER_TICKET]);
  });

  it("leaves out citations on other commits and citations of other kinds", () => {
    const review: QodoReview = {
      findings: [
        finding("1", OLDER, cite("ticket", TICKET)),
        finding("2", HEAD, cite("pr_branch_file", "src/a.ts[1-2]"), cite("web_page", "https://example.com")),
      ],
    };
    expect(ticketsCited(review, HEAD)).toEqual([]);
  });

  it("is empty, never an error, for findings without evidence or with a malformed citation", () => {
    const review = {
      findings: [
        { id: "1", git_sha: HEAD },
        { id: "2", git_sha: HEAD, evidence: null },
        { id: "3", git_sha: HEAD, evidence: { citations: [null, { source_type: "ticket", source: "" }] } },
      ],
    } as QodoReview;
    expect(ticketsCited(review, HEAD)).toEqual([]);
    expect(ticketsCited({}, HEAD)).toEqual([]);
  });
});
