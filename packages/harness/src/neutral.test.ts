import { describe, expect, it } from "vitest";
import { normalizeLookalikes, telltales, templateTelltales } from "./neutral.ts";

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
    // A case id in a branch name is caught in lower case too, as branch names are written (#190).
    expect(templateTelltales({ ...template, publish: { ...template.publish, branch: "ff-0002" } })).toEqual([
      "branch: contains a case id",
    ]);
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

describe("telltales: hyphenated, underscored and lower-case forms, as branch names write them (#190)", () => {
  it.each([
    ["ff-0002", "contains a case id"],
    ["FF_0002", "contains a case id"],
    ["ff0002", "contains a case id"],
    ["proof-test", "mentions the hidden proof test"],
    ["hidden_tests", "mentions the hidden proof test"],
    ["bug-injection", "says a bug was injected"],
    ["injected-bug", "says a bug was injected"],
    ["sabotaging the lookup", "says sabotage"],
    ["sabotages", "says sabotage"],
    ["mutant build", "says mutation"],
    ["plant a bug", "says planted"],
    ["planting-the-defect", "says planted"],
    ["answer_key", "mentions the answer key"],
  ])("flags %s", (text, reason) => {
    expect(telltales(text)).toContain(reason);
  });

  it.each([
    "Plant watering schedule",
    "buffer 1024 bytes",
    "tidy-replay-lookup",
    "faultforge-target",
    "affect 2000 rows",
  ])("still lets ordinary text through: %s", (text) => {
    expect(telltales(text)).toEqual([]);
  });

  it("refuses a template's own id or invariant id in a field the reviewer sees", () => {
    const named = {
      id: "replay-guard-v1",
      invariantId: "INV-IDEMP-001",
      find: "    const original = deps.store.getBooking(previous.bookingId);\n",
      replace: "    const original = deps.store.getBooking(idempotencyKey);\n",
      publish: { branch: "tidy-replay-lookup", commitMessage: "Simplify replay lookup in createBooking" },
    };
    expect(templateTelltales({ ...named, publish: { ...named.publish, branch: "replay-guard-v1" } })).toEqual([
      "branch: names replay-guard-v1",
    ]);
    expect(templateTelltales({ ...named, replace: "  // see inv-idemp-001\n" })).toEqual([
      "replace: names INV-IDEMP-001",
    ]);
    expect(templateTelltales(named)).toEqual([]);
  });
});

describe("telltales: one row per pattern, so none can be removed unnoticed (#188)", () => {
  it.each([
    ["Undo the sabotage", "says sabotage"],
    ["a saboteur's change", "says sabotage"],
    ["compare with the ground truth", "mentions ground truth"],
    ["read ground-truth.jsonl", "mentions ground truth"],
    ["after the Devil's Advocate pass", "names the challenger"],
    ["devils advocate notes", "names the challenger"],
    ["an inserted defect", "says a bug was injected"],
    ["fault injection run", "says a bug was injected"],
    ["the hidden tests", "mentions the hidden proof test"],
  ])("flags %s", (text, reason) => {
    expect(telltales(text)).toContain(reason);
  });
});

describe("telltales read look-alike and invisible characters as a reader sees them (#242)", () => {
  it.each([
    ["a Cyrillic a", "plаnted"],
    ["a Greek omicron", "grοund truth"],
    ["a zero-width joiner", "led‍ger"],
    ["a soft hyphen", "Fault­Forge"],
    ["a non-breaking hyphen", "FF‑0012"],
    ["full-width letters", "ｌｅｄｇｅｒ"],
  ])("finds a word written with %s", (_name, text) => {
    expect(telltales(text)).not.toEqual([]);
  });

  it("leaves ordinary text alone", () => {
    expect(normalizeLookalikes("Filter bookings by status")).toBe("Filter bookings by status");
    expect(telltales("Filter bookings by status")).toEqual([]);
  });
});
