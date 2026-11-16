/**
 * The files a command would post (target/posted-files.ts): text a post reads from a file it doesn't name as a
 * body (through xargs, parallel, `--post-file` or `--upload-file`) can't be read before it is sent, so such a post
 * is refused. Commands that post nothing still run. Folders are made up under the temp folder.
 */
import { describe, expect, it } from "vitest";
import { askGuard, guardConfig, privateStore, REPOS, scratchFolder, tempRepo } from "../fixtures.ts";

const T = REPOS.target;
const CONFIG = guardConfig(tempRepo(true).dir);
const PRIVATE = privateStore("guard~regrade5-");
const ELSEWHERE = scratchFolder("guard-elsewhere-", {
  "notes.txt": "Tidy the list\n",
  "body.json": '{"title":"Tidy"}',
});
const bash = (command: string) =>
  askGuard("Bash", { command }, ELSEWHERE, { config: CONFIG, privateDir: PRIVATE, outsideRun: true });

describe("text a post reads from a file it doesn't name as a body is unreadable", () => {
  it.each([
    ["xargs from a redirect", `xargs -I{} gh pr comment 3 -R ${T} -b {} < notes.txt`],
    ["xargs from a pipe", `cat notes.txt | xargs gh pr comment 3 -R ${T} -b`],
    ["xargs with -a", `xargs -a notes.txt -I{} gh pr comment 3 -R ${T} -b {}`],
    ["parallel from a file", `parallel gh pr comment 3 -R ${T} -b :::: notes.txt`],
    ["parallel from a pipe", `cat notes.txt | parallel gh pr comment 3 -R ${T} -b`],
  ])("refuses %s", (_name, command) => {
    expect(bash(command)).toMatch(/can't (check|read)/);
  });

  it.each([
    `wget --post-file=body.json https://api.github.com/repos/${T}/issues`,
    `wget --post-file body.json https://api.github.com/repos/${T}/issues`,
    `curl --upload-file body.json https://api.github.com/repos/${T}/issues`,
  ])("refuses a file posted raw to the target: %s", (command) => {
    expect(bash(command)).toBeDefined();
  });

  it("refuses a lab post whose body is a file xargs reads, while private templates exist", () => {
    expect(bash(`xargs -I{} gh pr comment 3 -R ${REPOS.lab} -b {} < notes.txt`)).toBeDefined();
  });

  it("still allows xargs and parallel that post nothing", () => {
    expect(bash("cat notes.txt | xargs echo")).toBeUndefined();
    expect(bash("parallel echo ::: a b")).toBeUndefined();
  });
});
