/**
 * Where git history and whole repos may go (target/history.ts): the private repo stays private and its history
 * goes only to its own origin, lab history never goes into a reviewed repo, no issue is transferred into one, and
 * a reviewed repo's refs aren't rewritten through the API. Repos and folders are made up under the temp folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  askGuard,
  DOOR,
  guardConfig,
  labWithPrivate,
  privateStore,
  REPOS,
  scratchFolder,
  tempRepo,
} from "../fixtures.ts";
import { decide } from "../guard-target.ts";

const T = REPOS.target;
const L = REPOS.lab;
const P = REPOS.private;
const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
/** The lab checkout, with the private checkout inside it as `private/`, as the owner keeps them. */
const { lab: LAB, privateDir: PRIVATE } = labWithPrivate();
/** A lab clone with a second remote that points at the target. */
const LAB_T = tempRepo(true);
LAB_T.git("remote", "add", "t", `https://github.com/${T}.git`);
/** A folder that is no checkout. */
const ELSEWHERE = scratchFolder("guard-elsewhere6-", { "vis.json": '{"private": false}' });

const bash = (command: string, cwd = ELSEWHERE) =>
  askGuard("Bash", { command }, cwd, { config: CONFIG, privateDir: PRIVATE, outsideRun: true });

describe("the private repo stays private", () => {
  it.each([
    `gh repo edit ${P} --visibility public --accept-visibility-change-consequences`,
    "gh repo edit --visibility=internal",
    `gh api -X PATCH repos/${P} -f private=false`,
    `gh api -X PATCH repos/${P} -F private=false`,
    `gh api -X PATCH repos/${P} -f visibility=public`,
    `gh api -X PATCH repos/${P} --input vis.json`,
    `curl -X PATCH https://api.github.com/repos/${P} -d '{"private": false}'`,
  ])("refuses a visibility change to public: %s", (command) => {
    expect(bash(command)).toMatch(/stays private/);
  });

  it("refuses a new repo made from the private checkout", () => {
    expect(bash("gh repo create leak --public --source=private --push", LAB.dir)).toMatch(/stays private/);
    expect(bash("gh repo create leak --private --source private", LAB.dir)).toMatch(/stays private/);
    expect(bash("gh repo create leak --public --source=. --push", PRIVATE)).toMatch(/stays private/);
  });

  it.each([
    [`git -C private push https://github.com/${L}.git HEAD:refs/heads/x`, LAB.dir],
    [`git push https://github.com/${L}.git HEAD:refs/heads/x`, PRIVATE],
    ["git push lab main", PRIVATE],
    ["cd private && git push lab main", LAB.dir],
    [`git push --repo=https://github.com/${L}.git`, PRIVATE],
    [`git remote set-url origin https://github.com/${L}.git`, PRIVATE],
    ["git remote add copy ../elsewhere", PRIVATE],
    [`git config remote.origin.pushurl https://github.com/${L}.git`, PRIVATE],
    ["git config branch.main.pushRemote lab", PRIVATE],
    ["git clone private ../copy", LAB.dir],
    [`git clone https://github.com/${P}.git copy`, ELSEWHERE],
    ["git fetch ./private main", LAB.dir],
  ])("refuses private history going anywhere but its origin: %s", (command, cwd) => {
    expect(bash(command, cwd)).toMatch(/stays private/);
  });

  it("still lets the private history go to its own origin, and reads its settings", () => {
    expect(bash("git push origin main", PRIVATE)).toBeUndefined();
    expect(bash("git push", PRIVATE)).toBeUndefined();
    expect(bash("git -C private push origin HEAD", LAB.dir)).toBeUndefined();
    expect(bash(`git push https://github.com/${P}.git main`, PRIVATE)).toBeUndefined();
    expect(bash("git config --get remote.origin.url", PRIVATE)).toBeUndefined();
    expect(bash("git remote -v", PRIVATE)).toBeUndefined();
    expect(bash("git fetch origin", LAB.dir)).toBeUndefined();
  });

  it("lets other repos be made and edited", () => {
    expect(bash("gh repo create scratch --public")).toBeUndefined();
    expect(bash(`gh repo edit ${L} --visibility private --accept-visibility-change-consequences`)).toBeUndefined();
    expect(bash(`gh repo edit ${L} --description "Tidy"`)).toBeUndefined();
  });

  it("refuses a private remote re-pointed with a value that reads like a read", () => {
    expect(bash(`git config remote.origin.pushurl https://github.com/${L}.git list`, PRIVATE)).toMatch(/stays private/);
  });

  it("reads a named remote a fetch copies from", () => {
    const lab = tempRepo();
    lab.git("remote", "add", "copy", PRIVATE);
    expect(bash("git fetch copy", lab.dir)).toMatch(/stays private/);
    lab.git("remote", "add", "gh", `https://github.com/${P}.git`);
    expect(bash("git pull gh main", lab.dir)).toMatch(/stays private/);
  });

  it("reads every push URL of a remote, not only its first", () => {
    const lab = tempRepo(true);
    lab.git("remote", "add", "both", `https://github.com/${L}.git`);
    lab.git("remote", "set-url", "--add", "--push", "both", `https://github.com/${L}.git`);
    lab.git("remote", "set-url", "--add", "--push", "both", `https://github.com/${T}.git`);
    expect(bash("git push both HEAD:refs/heads/tidy", lab.dir)).toMatch(/only from its own checkout/);
    const priv = join(lab.dir, "private");
    mkdirSync(priv);
    execFileSync("git", ["init", "-q", "-b", "main", priv]);
    execFileSync("git", ["-C", priv, "remote", "add", "origin", `https://github.com/${P}.git`]);
    execFileSync("git", ["-C", priv, "remote", "add", "backup", `https://github.com/${P}.git`]);
    execFileSync("git", ["-C", priv, "remote", "set-url", "--add", "--push", "backup", `https://github.com/${P}.git`]);
    execFileSync("git", ["-C", priv, "remote", "set-url", "--add", "--push", "backup", `https://github.com/${L}.git`]);
    const env: NodeJS.ProcessEnv = { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: priv };
    delete env.FAULTFORGE_FACTORY_RUN;
    const payload = JSON.stringify({ tool_name: "Bash", cwd: priv, tool_input: { command: "git push backup main" } });
    const decision = decide(payload, env);
    expect(decision.kind === "deny" ? decision.reason : decision.kind).toMatch(/stays private/);
  });

  it("doesn't take a private origin with a second push URL as private storage", () => {
    const lab = tempRepo(true);
    const priv = join(lab.dir, "private");
    mkdirSync(join(priv, "templates", "x-secret-v1"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", priv]);
    execFileSync("git", ["-C", priv, "remote", "add", "origin", `https://github.com/${P}.git`]);
    execFileSync("git", ["-C", priv, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${P}.git`]);
    execFileSync("git", ["-C", priv, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${L}.git`]);
    const ask2 = (command: string, cwd: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: priv };
      delete env.FAULTFORGE_FACTORY_RUN;
      const decision = decide(JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), env);
      return decision.kind === "deny" ? decision.reason : decision.kind;
    };
    expect(ask2("git push origin main", priv)).toMatch(/stays private/);
    expect(ask2(`gh issue comment 3 -R ${L} -b "x-secret-v1"`, lab.dir)).toMatch(/still private/);
  });
});

describe("lab history never goes into a reviewed repo", () => {
  it.each([
    [`git push https://github.com/${T}.git main:refs/heads/tidy`, LAB.dir],
    [`git push git@github.com:${T}.git HEAD:refs/heads/tidy`, LAB.dir],
    ["git push t HEAD:refs/heads/tidy", LAB_T.dir],
    [`git push ${TARGET_REPO.dir.replace(/\\/g, "/")} HEAD:refs/heads/tidy`, LAB.dir],
    [`git -C ${LAB.dir.replace(/\\/g, "/")} push https://github.com/${T}.git HEAD:refs/heads/tidy`, ELSEWHERE],
  ])("refuses %s", (command, cwd) => {
    expect(bash(command, cwd)).toMatch(/only from its own checkout/);
  });

  it("refuses an issue transferred into a reviewed repo", () => {
    expect(bash(`gh issue transfer 5 ${T}`, LAB.dir)).toMatch(/transferred/);
    expect(bash(`gh issue transfer 5 faultforge-target -R ${L}`)).toMatch(/transferred/);
    expect(
      bash(
        `gh api graphql -f query='mutation{transferIssue(input:{issueId:"I_1",repositoryId:"R_1"}){issue{number}}}'`,
      ),
    ).toMatch(/transferred/);
    expect(bash(`gh issue transfer 5 ${L}-notes -R ${L}`)).toBeUndefined();
  });

  it("sends a reviewed checkout's push to its own repo through the door", () => {
    expect(bash("git push origin HEAD:refs/heads/tidy", TARGET_REPO.dir)).toMatch(/go only through the door/);
    expect(bash(`git push https://github.com/${T}.git HEAD:refs/heads/tidy`, TARGET_REPO.dir)).toMatch(
      /go only through the door/,
    );
  });

  it("compares a transfer's owner as well as its name", () => {
    expect(bash("gh issue transfer 5 other-owner/faultforge-target -R other-owner/source")).toBeUndefined();
    expect(bash(`gh issue transfer 5 ${T.toUpperCase()} -R other-owner/source`)).toMatch(/transferred/);
  });

  it("doesn't take a checkout whose origin pushes to a reviewed repo as that repo's own", () => {
    const other = tempRepo(true);
    other.git("remote", "set-url", "origin", `https://github.com/${L}-notes.git`);
    other.git("remote", "set-url", "--add", "--push", "origin", `https://github.com/${L}-notes.git`);
    other.git("remote", "set-url", "--add", "--push", "origin", `https://github.com/${T}.git`);
    expect(bash("git push origin HEAD:refs/heads/tidy", other.dir)).toMatch(/only from its own checkout/);
  });
});

describe("refs on a reviewed repo can't be rewritten through the API", () => {
  const target = tempRepo(true);
  const config = guardConfig(target.dir);
  const privateDir = privateStore("guard~private-");
  const elsewhere = scratchFolder("guard-elsewhere-", {
    "body.json": '{"title":"Tidy"}',
    "del.graphql": 'mutation { deleteRef(input: {refId: "R_x"}) { clientMutationId } }',
  });
  const ask = (command: string, cwd = elsewhere) =>
    askGuard("Bash", { command }, cwd, { config, privateDir, outsideRun: true });

  it.each([
    `gh api repos/${T}/git/refs/heads/case-x -X PATCH -F force=true -f sha=abc`,
    `gh api repos/${T}/git/refs/heads/main -X DELETE`,
    `gh api -X DELETE repos/${T}/git/refs/heads/some-branch`,
    `gh api --method=DELETE /repos/${T}/git/refs/tags/v1`,
    `gh api repos/${T}/git/refs/heads/main -X PATCH -f sha=abc`,
    `gh api repos/${T}/git/refs/heads/main --method PATCH -f sha=abc -F force=false`,
    `gh api repos/${T}/git/refs/heads/main --input body.json`,
    `gh api -XPOST repos/${T}/git/refs -f ref=refs/heads/tidy -f sha=abc -F force=true`,
    `gh repo sync ${T} --source AJBeumer/other --force`,
  ])("refuses %s", (command) => {
    expect(ask(command)).toMatch(DOOR);
  });

  it("allows reading refs; creating one goes through the door", () => {
    expect(ask(`gh api repos/${T}/git/refs/heads/main`)).toBeUndefined();
    expect(ask(`gh api repos/${T}/git/matching-refs/heads/`)).toBeUndefined();
    expect(ask(`gh api -X POST repos/${T}/git/refs -f ref=refs/heads/tidy-list -f sha=abc`)).toMatch(DOOR);
  });

  it("leaves the lab's own refs alone", () => {
    expect(ask(`gh api -X DELETE repos/${L}/git/refs/heads/old-branch`)).toBeUndefined();
  });

  it("refuses a ref mutation read from a query file", () => {
    expect(ask("gh api graphql -F query=@del.graphql")).toMatch(DOOR);
  });

  it.each([
    `gh api repos/${T}/git/refs/heads/main -X=DELETE`,
    `gh api repos/${T}/git/refs/heads/main -X GET -X DELETE`,
  ])("reads every method flag: %s", (command) => {
    expect(ask(command)).toMatch(DOOR);
  });

  it("reads gh's repo placeholders as the checkout's repo", () => {
    expect(ask("gh api repos/{owner}/{repo}/git/refs/heads/main -X DELETE", target.dir)).toMatch(DOOR);
    expect(ask("gh api repos/:owner/:repo/git/refs/heads/main -X PATCH -F force=true", target.dir)).toMatch(DOOR);
  });
});
