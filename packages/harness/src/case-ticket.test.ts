import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alreadyTicketed,
  buildBody,
  issueNumberFromUrl,
  run,
  ticketFieldProblems,
  ticketLinkGiveaways,
} from "./case-ticket.ts";
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

  it("names a non-string criterion instead of crashing (#152)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a malformed template can hold anything in JSON
    expect(ticketFieldProblems({ ...TICKET, criteria: ["ok", 5 as any] })).toContain(
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

  it("still puts criteria as checkboxes when the checklist is the first section (#152)", () => {
    const reordered = { sections: ["Acceptance criteria", "What", "Must not break"], checklist: "Acceptance criteria" };
    const body = buildBody(reordered, TICKET);
    expect(body).toBe(
      [
        "### Acceptance criteria",
        "- [ ] A repeat request returns the original booking unchanged.",
        "- [ ] Existing tests continue to pass.",
        "",
        "### What",
        TICKET.what,
        "",
        "### Must not break",
        "- Nothing else about booking behavior is expected to change.",
      ].join("\n"),
    );
  });
});

describe("ticketLinkGiveaways (#152)", () => {
  it("is empty for ordinary ticket text", () => {
    expect(ticketLinkGiveaways(TICKET)).toEqual([]);
  });

  it("flags a GitHub issue URL in ticket.what", () => {
    expect(
      ticketLinkGiveaways({
        ...TICKET,
        what: "See https://github.com/AJBeumer/faultforge-target/issues/7 for context.",
      }),
    ).toContain("ticket.what: links to a GitHub issue or PR");
  });

  it("flags a GitHub pull URL in a criterion", () => {
    expect(
      ticketLinkGiveaways({ ...TICKET, criteria: ["See https://github.com/AJBeumer/faultforge/pull/9", "ok"] }),
    ).toContain("ticket.criteria[0]: links to a GitHub issue or PR");
  });

  it("flags a short repo#number reference in the title", () => {
    expect(ticketLinkGiveaways({ ...TICKET, title: "Follow-up to faultforge-target#7" })).toContain(
      "ticket.title: links to a GitHub issue or PR",
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
  // The case was planted from this template: a real run is refused for any case the answer key doesn't hold.
  writeFileSync(
    join(privateDir, "ground-truth.jsonl"),
    `${JSON.stringify({ caseId: "FF-0009", kind: "sabotage", templateId: "a-template" })}\n`,
  );
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

  it("refuses a template whose ticket text links to a GitHub issue (#152)", async () => {
    const base = mkdtempSync(join(tmpdir(), "faultforge-case-ticket-"));
    const privateDir = join(base, "private");
    const templatesDir = join(privateDir, "templates", "linked-template");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      join(templatesDir, "template.json"),
      JSON.stringify({
        ...TEMPLATE,
        id: "linked-template",
        ticket: { ...TICKET, what: "See https://github.com/AJBeumer/faultforge-target/issues/7 for context." },
      }),
    );
    let ghCalled = false;
    const code = await run("linked-template", "FF-0012", {
      env: { FAULTFORGE_PRIVATE_DIR: privateDir },
      auditEventsPath: join(privateDir, "audit-events.jsonl"),
      evidenceDir: join(privateDir, "raw-artifacts", "FF-0012"),
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

  it("refuses a case id that would escape private storage (#152)", async () => {
    const { env } = setup();
    let ghCalled = false;
    const code = await run("a-template", "../../outside", {
      env,
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

  it("saves the raw gh output before parsing, so a parse failure doesn't lose a created issue (#152)", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    const code = await run("a-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      log: () => {},
      error: () => {},
      gh: () => "not a url gh changed its output format",
    });

    expect(code).toBe(2);
    expect(readFileSync(join(evidenceDir, "gh-issue-create.raw.txt"), "utf8")).toContain("not a url");
    // Nothing recorded as ticketed, since the issue number was never confirmed.
    expect(() => readFileSync(auditEventsPath, "utf8")).toThrow();
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

  it("refuses a rerun after a call that may have created the issue, and never calls gh again (#216)", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    let calls = 0;
    const timesOut = () => {
      calls++;
      throw new Error("ETIMEDOUT");
    };
    const options = { env, auditEventsPath, evidenceDir, factory: FACTORY, log: () => {}, gh: timesOut };
    expect(await run("a-template", "FF-0009", { ...options, error: () => {} })).toBe(2);
    const errors: string[] = [];
    expect(await run("a-template", "FF-0009", { ...options, error: (l) => errors.push(l) })).toBe(2);
    expect(calls).toBe(1);
    expect(errors.join("\n")).toContain("an earlier run tried to create this ticket");
  });
});

describe("run: the ticket matches the case's answer-key entry (#249, AUD-M24)", () => {
  async function attempt(caseId: string, options: { dryRun?: boolean; groundTruth?: string } = {}) {
    const { env, auditEventsPath, evidenceDir } = setup();
    const groundTruthPath = join(env.FAULTFORGE_PRIVATE_DIR, "ground-truth.jsonl");
    if (options.groundTruth !== undefined) writeFileSync(groundTruthPath, options.groundTruth);
    const errors: string[] = [];
    let ghCalled = false;
    const code = await run("a-template", caseId, {
      env,
      auditEventsPath,
      groundTruthPath,
      evidenceDir,
      factory: FACTORY,
      dryRun: options.dryRun ?? false,
      log: () => {},
      error: (line) => errors.push(line),
      gh: () => {
        ghCalled = true;
        return "https://github.com/AJBeumer/faultforge-target/issues/42\n";
      },
    });
    return { code, err: errors.join("\n"), ghCalled };
  }

  it("refuses a template other than the one the case planted, before calling gh", async () => {
    const other = `${JSON.stringify({ caseId: "FF-0009", kind: "sabotage", templateId: "another-template" })}\n`;
    const { code, err, ghCalled } = await attempt("FF-0009", { groundTruth: other });
    expect(code).toBe(1);
    expect(err).toContain("planted template another-template, not a-template");
    expect(ghCalled).toBe(false);
  });

  it("refuses a real run for a case the answer key doesn't hold yet; a dry run may come first", async () => {
    const real = await attempt("FF-0010");
    expect(real.code).toBe(1);
    expect(real.err).toContain("not in the answer key yet");
    expect(real.ghCalled).toBe(false);
    expect((await attempt("FF-0010", { dryRun: true })).code).toBe(0);
  });

  it("refuses, exit 2, while the answer key has an amendment problem", async () => {
    const broken = [
      JSON.stringify({ caseId: "FF-0009", kind: "sabotage", templateId: "a-template" }),
      JSON.stringify({
        kind: "amendment",
        amends: "FF-0009",
        change: { caseId: "FF-0001" },
        reason: "r",
        evidence: "e",
      }),
    ].join("\n");
    const { code, err, ghCalled } = await attempt("FF-0009", { groundTruth: `${broken}\n` });
    expect(code).toBe(2);
    expect(err).toContain("has problems");
    expect(ghCalled).toBe(false);
  });
});

describe("run: a template changed after its case was planted (Qodo on PR 264)", () => {
  it("is refused through the injection event's hash, before gh is called", async () => {
    const { env, auditEventsPath, evidenceDir } = setup();
    writeFileSync(
      auditEventsPath,
      `${JSON.stringify({ eventId: "i", type: "sabotage.injected", caseId: "FF-0009", at: "2026-11-01T00:00:00Z", tool: "faultforge-harness@1.0.0", inputHash: "0".repeat(64) })}\n`,
    );
    const errors: string[] = [];
    let ghCalled = false;
    const code = await run("a-template", "FF-0009", {
      env,
      auditEventsPath,
      evidenceDir,
      factory: FACTORY,
      log: () => {},
      error: (l) => errors.push(l),
      gh: () => {
        ghCalled = true;
        return "";
      },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("isn't the one it was planted from");
    expect(ghCalled).toBe(false);
  });
});
