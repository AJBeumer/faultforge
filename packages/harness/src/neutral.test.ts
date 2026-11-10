import { describe, expect, it } from "vitest";
import { telltales, templateTelltales } from "./neutral.ts";

describe("telltales", () => {
  it.each([
    "Simplify replay lookup in createBooking",
    "tidy-replay-lookup",
    "Shorten README intro",
    "await app.inject(request)",
    "Clock and id generator are injected",
    "Normalize line endings to LF",
  ])("lets ordinary text through: %s", (text) => {
    expect(telltales(text)).toEqual([]);
  });

  it.each([
    ["FaultForge case", "names the lab"],
    ["Fix planted bug", "says planted"],
    ["injected bug in create.ts", "says a bug was injected"],
    ["Add mutation testing", "says mutation"],
    ["Update ledger", "mentions the ledger"],
    ["see the answer key", "mentions the answer key"],
    ["covered by the proof test", "mentions the hidden proof test"],
    ["closes FF-0002", "contains a case id"],
  ])("flags %s", (text, reason) => {
    expect(telltales(text)).toContain(reason);
  });

  it("allows the target repository's own name", () => {
    expect(telltales("faultforge-target")).toEqual([]);
  });
});

describe("templateTelltales (#105)", () => {
  const template = {
    find: "    const original = deps.store.getBooking(previous.bookingId);\n",
    replace: "    const original = deps.store.getBooking(idempotencyKey);\n",
    proofTest: "proof.test.ts",
    publish: { branch: "tidy-replay-lookup", commitMessage: "Simplify replay lookup in createBooking" },
  };

  it("passes a template whose every reviewer-visible field reads as ordinary", () => {
    expect(templateTelltales(template)).toEqual([]);
  });

  it("names the field that would give the case away, for every field that reaches the reviewed repo", () => {
    expect(templateTelltales({ ...template, replace: "    // planted: look up by key\n" })).toEqual([
      "replace: says planted",
    ]);
    expect(templateTelltales({ ...template, find: "// FaultForge marker\n" })).toEqual(["find: names the lab"]);
    // The proof test stays private, so its name is not one of the checked fields (it isn't even in the type).
    expect(templateTelltales({ ...template, publish: { ...template.publish, branch: "ff-0002" } })).toEqual([]);
    expect(
      templateTelltales({ ...template, publish: { branch: "FF-0002-fix", commitMessage: "Fix planted bug" } }),
    ).toEqual(["branch: contains a case id", "commitMessage: says planted"]);
  });

  it("checks the ticket's title, what and criteria, the target ticket the case PR will claim to make", () => {
    const withTicket = {
      ...template,
      ticket: {
        title: "Simplify replay lookup",
        what: "Read the booking id straight off the record.",
        criteria: ["Replays still return the original booking."],
      },
    };
    expect(templateTelltales(withTicket)).toEqual([]);
    expect(templateTelltales({ ...withTicket, ticket: { ...withTicket.ticket, title: "Fix planted bug" } })).toEqual([
      "ticket.title: says planted",
    ]);
    expect(templateTelltales({ ...withTicket, ticket: { ...withTicket.ticket, what: "See the answer key" } })).toEqual([
      "ticket.what: mentions the answer key",
    ]);
    expect(
      templateTelltales({ ...withTicket, ticket: { ...withTicket.ticket, criteria: ["Closes FF-0002"] } }),
    ).toEqual(["ticket.criteria[0]: contains a case id"]);
  });
});
