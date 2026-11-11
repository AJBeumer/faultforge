import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alreadyTicketed, buildBody, issueNumberFromUrl, run, ticketFieldProblems } from "./case-ticket.ts";
import type { FactoryConfig } from "./factory-config.ts";

const TICKET = {
  title: "Simplify replay lookup in createBooking",
  what: "The replay branch looks up the original booking through an extra value instead of the id already on the record.",
  criteria: ["A repeat request returns the original booking unchanged.", "Existing tests continue to pass."],
};

const TEMPLATE = {
  id: "a-template",
  kind: "bug" as const,
  find: "a",
  replace: "b",
  publish: { branch: "tidy-replay-lookup", commitMessage: "Simplify replay lookup" },
  ticket: TICKET,
};

const TARGET_REPO: FactoryConfig["repos"][string] = {
  github: "AJBeumer/faultforge-target",
  path: "../faultforge-target",
  guard: "reviewed",
  check: "npm run check",
  tests: "(^test/|\\.test\\.ts$)",
  start: null,
  tickets: { sections: ["What", "Acceptance criteria", "Must not break"], checklist: "Acceptance criteria" },
  board: false,
};

const FACTORY: FactoryConfig = {
  evidence: "private/raw-artifacts",
  repos: { target: TARGET_REPO },
};

describe("ticketFieldProblems", () => {
  it("is empty for a complete ticket", () => {
    expect(ticketFieldProblems(TICKET)).toEqual([]);
  });

  it("names a missing ticket field", () => {
    expect(ticketFieldProblems(undefined)).toEqual(["template has no ticket field"]);
  });

  it("names a blank title", () => {
    expect(ticketFieldProblems({ ...TICKET, title: "  " })).toContain("ticket.title is missing or blank");
  });

  it("names empty criteria", () => {
    expect(ticketFieldProblems({ ...TICKET, criteria: [] })).toContain(
      "ticket.criteria is missing, empty, or has a blank entry",
    );
  });

  it("names a blank criterion", () => {
    expect(ticketFieldProblems({ ...TICKET, criteria: ["ok", "  "] })).toContain(
      "ticket.criteria is missing, empty, or has a blank entry",
    );
  });
});

describe("buildBody", () => {
  const sections = TARGET_REPO.tickets;

  it("puts ticket.what under the first section and criteria as checkboxes under the checklist", () => {
    const body = buildBody(sections, TICKET);
    expect(body).toBe(
      [
        "### What",
        TICKET.what,
        "",
        "### Acceptance criteria",
        "- [ ] A repeat request returns the original booking unchanged.",
        "- [ ] Existing tests continue to pass.",
        "",
        "### Must not break",
        "- Nothing else about booking behavior is expected to change.",
      ].join("\n"),
    );
  });
});

describe("alreadyTicketed", () => {
  it("is false with no matching event", () => {
    expect(alreadyTicketed([{ type: "sabotage.injected", caseId: "FF-0009" }], "FF-0009")).toBe(false);
  });

  it("is true once a case.ticket-created event exists for the case", () => {
    expect(alreadyTicketed([{ type: "case.ticket-created", caseId: "FF-0009" }], "FF-0009")).toBe(true);
  });

  it("ignores another case's ticket event", () => {
    expect(alreadyTicketed([{ type: "case.ticket-created", caseId: "FF-0001" }], "FF-0009")).toBe(false);
  });
});

describe("issueNumberFromUrl", () => {
  it("reads the number off an issue URL", () => {
    expect(issueNumberFromUrl("https://github.com/AJBeumer/faultforge-target/issues/42\n")).toBe(42);
  });

  it("is undefined for anything else", () => {
    expect(issueNumberFromUrl("not a url")).toBeUndefined();
  });
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), "faultforge-case-ticket-"));
  const privateDir = join(base, "private");
  const templatesDir = join(privateDir, "templates", "a-template");
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, "template.json"), JSON.stringify(TEMPLATE));
  return {
    env: { FAULTFORGE_PRIVATE_DIR: privateDir },
    auditEventsPath: join(privateDir, "audit-events.jsonl"),
    evidenceDir: join(privateDir, "raw-artifacts", "FF-0009"),
  };
}

describe("run", () => {
  it("creates the issue, saves the evidence and appends the audit event", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    const ghCalls: string[][] = [];
    const log: string[] = [];
    const code = await run("a-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      log: (line) => log.push(line),
      error: (line) => log.push(line),
      now: () => "2026-11-11T00:00:00.000Z",
      eventId: () => "event-1",
      gh: (args) => {
        ghCalls.push(args);
        return "https://github.com/AJBeumer/faultforge-target/issues/42\n";
      },
    });

    expect(code).toBe(0);
    expect(ghCalls).toEqual([
      [
        "issue",
        "create",
        "--repo",
        "AJBeumer/faultforge-target",
        "--title",
        TICKET.title,
        "--body",
        buildBody(TARGET_REPO.tickets, TICKET),
      ],
    ]);
    expect(log.join("\n")).toContain("Closes #42");

    const saved = JSON.parse(readFileSync(join(evidenceDir, "ticket.json"), "utf8"));
    expect(saved).toEqual({
      repo: "AJBeumer/faultforge-target",
      number: 42,
      url: "https://github.com/AJBeumer/faultforge-target/issues/42",
      title: TICKET.title,
      body: buildBody(TARGET_REPO.tickets, TICKET),
    });

    const events = readFileSync(auditEventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events).toEqual([
      {
        eventId: "event-1",
        type: "case.ticket-created",
        at: "2026-11-11T00:00:00.000Z",
        caseId: "FF-0009",
        issue: saved,
      },
    ]);
  });

  it("dry run prints the issue text without creating anything or touching private storage", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    let ghCalled = false;
    const log: string[] = [];
    const code = await run("a-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      dryRun: true,
      log: (line) => log.push(line),
      error: (line) => log.push(line),
      gh: () => {
        ghCalled = true;
        return "";
      },
    });

    expect(code).toBe(0);
    expect(ghCalled).toBe(false);
    expect(log.join("\n")).toContain(TICKET.title);
    expect(log.join("\n")).toContain("### Acceptance criteria");
    expect(() => readFileSync(auditEventsPath, "utf8")).toThrow();
    expect(() => readFileSync(join(evidenceDir, "ticket.json"), "utf8")).toThrow();
  });

  it("refuses a template whose ticket text would give the case away", async () => {
    const base = mkdtempSync(join(tmpdir(), "faultforge-case-ticket-"));
    const privateDir = join(base, "private");
    const templatesDir = join(privateDir, "templates", "telltale-template");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      join(templatesDir, "template.json"),
      JSON.stringify({ ...TEMPLATE, id: "telltale-template", ticket: { ...TICKET, what: "Fix planted bug" } }),
    );
    let ghCalled = false;
    const code = await run("telltale-template", "FF-0010", {
      env: { FAULTFORGE_PRIVATE_DIR: privateDir },
      auditEventsPath: join(privateDir, "audit-events.jsonl"),
      evidenceDir: join(privateDir, "raw-artifacts", "FF-0010"),
      factory: FACTORY,
      log: () => {},
      error: () => {},
      gh: () => {
        ghCalled = true;
        return "";
      },
    });

    expect(code).toBe(1);
    expect(ghCalled).toBe(false);
  });

  it("refuses a template with no ticket field", async () => {
    const base = mkdtempSync(join(tmpdir(), "faultforge-case-ticket-"));
    const privateDir = join(base, "private");
    const templatesDir = join(privateDir, "templates", "no-ticket-template");
    mkdirSync(templatesDir, { recursive: true });
    const { ticket, ...withoutTicket } = TEMPLATE;
    writeFileSync(join(templatesDir, "template.json"), JSON.stringify({ ...withoutTicket, id: "no-ticket-template" }));
    const code = await run("no-ticket-template", "FF-0011", {
      env: { FAULTFORGE_PRIVATE_DIR: privateDir },
      auditEventsPath: join(privateDir, "audit-events.jsonl"),
      evidenceDir: join(privateDir, "raw-artifacts", "FF-0011"),
      factory: FACTORY,
      log: () => {},
      error: () => {},
      gh: () => "",
    });

    expect(code).toBe(1);
  });

  it("refuses a second call for the same case", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    writeFileSync(
      auditEventsPath,
      `${JSON.stringify({ eventId: "e0", type: "case.ticket-created", at: "2026-11-10T00:00:00.000Z", caseId: "FF-0009", issue: {} })}\n`,
    );
    let ghCalled = false;
    const code = await run("a-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      log: () => {},
      error: () => {},
      gh: () => {
        ghCalled = true;
        return "";
      },
    });

    expect(code).toBe(1);
    expect(ghCalled).toBe(false);
  });

  it("exits 2 when the template isn't found", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    const code = await run("missing-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(2);
  });

  it("exits 2 when gh fails to create the issue", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    const code = await run("a-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      log: () => {},
      error: () => {},
      gh: () => {
        throw new Error("gh: not authenticated");
      },
    });

    expect(code).toBe(2);
    expect(() => readFileSync(auditEventsPath, "utf8")).toThrow();
  });
});
