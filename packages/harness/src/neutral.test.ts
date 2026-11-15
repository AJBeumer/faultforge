import { describe, expect, it } from "vitest";
import {
  addressesQodo,
  normalizeLookalikes,
  readerViews,
  renderedText,
  telltales,
  templateTelltales,
} from "./neutral.ts";

describe("addressesQodo (re-grade 6: Q25, Q26)", () => {
  it("tells a Qodo address from ordinary text", () => {
    expect(addressesQodo("/ask why?")).toBe(true);
    expect(addressesQodo("ok\n  /improve")).toBe(true);
    expect(addressesQodo("hi @qodo-merge-pro")).toBe(true);
    expect(addressesQodo("see src/review/ask.ts and /health")).toBe(false);
    expect(addressesQodo("mail me at me@qodo.ai")).toBe(false);
  });
});

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

describe("telltales read the lab's name inside a joined word (re-grade 5)", () => {
  it.each([
    "faultforge_private",
    "faultforge_lab",
    "FaultForgeLab",
    "myFaultForge",
    "faultforgelab",
    "faultforge2",
    "2faultforge",
    "FAULTFORGE_PRIVATE",
    "FaultFORGE",
    "fault_forge",
  ])("flags %s", (text) => {
    expect(telltales(`see ${text}`)).toContain("names the lab");
  });

  it.each([
    "faultforge-target",
    "AJBeumer/faultforge-target",
    "the default forge settings",
    "defaultForge",
    "a fault for get",
  ])("lets %s through", (text) => {
    expect(telltales(text)).toEqual([]);
  });
});

describe("camel-case joins are split only for the lab's name (re-grade 5)", () => {
  it("leaves code such as clientMutationId and answerKeys alone", () => {
    expect(telltales("addComment { clientMutationId }")).toEqual([]);
    expect(telltales("const answerKeys = []")).toEqual([]);
  });
});

describe("telltales read text as markdown renders it, and a dot as a separator (re-grade 7)", () => {
  it.each([
    ["an HTML comment", "fault<!-- -->forge"],
    ["an empty HTML comment", "plan<!---->ted bug"],
    ["a decimal entity", "pl&#97;nted bug"],
    ["a hex entity", "&#x66;aultforge"],
    ["a named entity for a separator", "answer&lowbar;key"],
    ["a named entity that renders as nothing", "led&shy;ger"],
    ["bold", "plan**ted** bug"],
    ["underscore bold", "led__ger__"],
    ["strikethrough", "led~~ger~~"],
    ["a code span", "fault`forge`"],
    ["an inline tag", "plan<b></b>ted bug"],
    ["a dot", "the answer.key"],
    ["an entity dot", "ground&period;truth"],
  ])("finds a word split by %s", (_name, text) => {
    expect(telltales(text)).not.toEqual([]);
  });

  it("still finds a word a code span starts right after a letter, as written", () => {
    expect(telltales("n`faultforge replay`")).toContain("names the lab");
  });

  it("decodes each entity once, as a reader sees it, and keeps a named entity with no semicolon", () => {
    expect(renderedText("a &amp;#97; b")).toBe("a &#97; b");
    expect(renderedText("AT&T and x &lt y")).toBe("AT&T and x &lt y");
    expect(renderedText("&#0; &#9999999;")).toBe(" ");
  });

  it.each([
    "const total = a * b;",
    "if (a && b) return;",
    "app.inject(request)",
    "bookings.filter((b) => b.status === 'open')",
    "Use `npm test` before a push",
    "x.ledgerless?", // not a word on its own
  ])("leaves ordinary text alone: %s", (text) => {
    expect(telltales(text)).toEqual([]);
  });

  it("is one step: rendering changes nothing in plain text", () => {
    expect(readerViews("Filter bookings by status")).toEqual(["Filter bookings by status"]);
    expect(readerViews("plan**ted**")).toEqual(["plan**ted**", "planted"]);
  });
});

describe("markup read as rendered, after Qodo on PR 339", () => {
  it("leaves a named entity GitHub doesn't know as written", () => {
    expect(renderedText("fault&bogus;forge")).toBe("fault&bogus;forge");
    expect(telltales("fault&bogus;forge")).toEqual([]);
    expect(telltales("led&shy;ger")).toContain("mentions the ledger");
  });

  it("reads a line-break or block tag as a new line", () => {
    expect(renderedText("a<br>b<br/>c<p>d")).toBe("a\nb\nc\nd");
    expect(telltales("fault<br>forge")).toContain("names the lab");
  });
});
