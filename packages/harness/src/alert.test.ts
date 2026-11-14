import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Alert, alertText, ghIssues, type Issues, KINDS, main, Refused, raise } from "./alert.ts";

describe("the alert script runs on plain node, as the workflow runs it (#308)", () => {
  it("needs nothing installed and refuses an unknown kind with exit 1", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "alert.ts"), "nope", "x"], { encoding: "utf8" });
    expect(run.stderr).toContain("alert: refused");
    expect(run.status).toBe(1);
  });
});

const ENV = {
  GITHUB_WORKFLOW: "Check",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "AJBeumer/faultforge",
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "2",
};

/** Issues kept in memory, with every call recorded. */
function fakeIssues(open: { number: number; title: string }[] = []) {
  const calls: string[] = [];
  const issues: Issues = {
    openAlerts: () => open,
    comment: (issue, body) => {
      calls.push(`comment #${issue}: ${body}`);
    },
    create: (title, body) => {
      calls.push(`create ${title}: ${body}`);
      open.push({ number: 100 + open.length, title });
    },
  };
  return { issues, calls };
}

describe("the alert's text (#308)", () => {
  it("is fixed words, the workflow's name and the run's URL", () => {
    expect(alertText("ci-main", "failure", ENV)).toEqual({
      title: "Alert: CI on main failed",
      body: [
        "Workflow: Check",
        "Run: https://github.com/AJBeumer/faultforge/actions/runs/123456/attempts/2",
        "Outcome: a job failed",
      ].join("\n"),
    });
    expect(alertText("factory", "3", { ...ENV, GITHUB_WORKFLOW: "Factory" }).body).toContain(
      "Outcome: exit 3: the tick stopped with an error",
    );
  });

  it.each([
    ["an unknown kind", "deploy", "failure", ENV],
    ["an outcome that isn't the kind's", "factory", "1", ENV],
    ["free text as the outcome", "ci-main", "see D:/Projects/x/private/log.txt", ENV],
    ["an inherited key as the kind", "constructor", "failure", ENV],
    ["a workflow name with a path", "ci-main", "failure", { ...ENV, GITHUB_WORKFLOW: "../private/notes" }],
    ["a run id that isn't a number", "ci-main", "failure", { ...ENV, GITHUB_RUN_ID: "1; echo x" }],
    ["a repository that isn't owner/name", "ci-main", "failure", { ...ENV, GITHUB_REPOSITORY: "x" }],
    ["no run id", "ci-main", "failure", { ...ENV, GITHUB_RUN_ID: undefined }],
  ])("refuses %s", (_name, kind, outcome, env) => {
    expect(() => alertText(kind, outcome, env)).toThrow(Refused);
  });

  it("never names a private path or a log line in any fixed text", () => {
    for (const kind of Object.values(KINDS)) {
      for (const text of [kind.title, ...Object.values(kind.outcomes)]) expect(text).not.toMatch(/private|[/\\]/);
    }
  });
});

describe("one alert issue per kind (#308)", () => {
  const alert: Alert = { title: "Alert: CI on main failed", body: "Outcome: a job failed" };

  it("opens one when none is open, then comments on it", () => {
    const { issues, calls } = fakeIssues();
    expect(raise(alert, issues)).toEqual({ action: "opened" });
    expect(raise(alert, issues)).toEqual({ action: "commented", issue: 100 });
    expect(raise(alert, issues)).toEqual({ action: "commented", issue: 100 });
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("comments on the oldest open one of the same kind, never on another kind's", () => {
    const { issues, calls } = fakeIssues([
      { number: 9, title: "Alert: a factory run failed" },
      { number: 12, title: alert.title },
      { number: 7, title: alert.title },
    ]);
    expect(raise(alert, issues)).toEqual({ action: "commented", issue: 7 });
    expect(calls).toEqual([`comment #7: ${alert.body}`]);
  });
});

describe("the gh calls", () => {
  it("lists open alert issues, skips PRs, comments, and labels a new issue", () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return args[0] === "api"
        ? JSON.stringify([
            { number: 4, title: "Alert: x" },
            { number: 5, title: "Alert: x", pull_request: {} },
          ])
        : "";
    };
    const issues = ghIssues("AJBeumer/faultforge", gh);
    expect(issues.openAlerts()).toEqual([{ number: 4, title: "Alert: x" }]);
    expect(calls[0]).toEqual(["api", "repos/AJBeumer/faultforge/issues?labels=alert&state=open&per_page=100"]);
    issues.comment(4, "b");
    expect(calls[1]).toEqual(["issue", "comment", "4", "--repo", "AJBeumer/faultforge", "--body", "b"]);
    issues.create("Alert: x", "b");
    expect(calls[2]?.slice(0, 3)).toEqual(["label", "create", "alert"]);
    expect(calls[3]).toEqual([
      "issue",
      "create",
      "--repo",
      "AJBeumer/faultforge",
      "--title",
      "Alert: x",
      "--label",
      "alert",
      "--body",
      "b",
    ]);
  });
});

describe("the exit codes", () => {
  it("is 0 when posted, 1 when refused, 2 when gh fails", () => {
    expect(main(["ci-main", "failure"], ENV, fakeIssues().issues)).toBe(0);
    expect(main(["ci-main", "nope"], ENV, fakeIssues().issues)).toBe(1);
    const broken: Issues = {
      openAlerts: () => {
        throw new Error("gh: HTTP 403");
      },
      comment: () => {},
      create: () => {},
    };
    expect(main(["factory", "2"], ENV, broken)).toBe(2);
  });
});
