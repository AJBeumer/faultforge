# 15. Adoption and access

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

FaultForge serves two audiences with one engine. Judges must be able to try it within minutes, without a Qodo account. Developers must be able to point it at their own project with one command. After the hackathon, a hosted app is built on the same core and data. The seed app stays as the controlled benchmark and the demo fixture. It is not the only target.

## 15.1 Judges: three levels, no setup

| Level | What the judge does | What it needs |
|---|---|---|
| Browse | Open the published Debate Chamber site and read every real case, finding, test, and verdict | A browser |
| Replay | Open the repository in a GitHub Codespace and run `faultforge replay` | A GitHub account |
| Live | Run the full pipeline against the seed app or their own repository | A Qodo account |

**Replay mode** re-runs the whole pipeline from Qodo output recorded in the audit log. Injection, matching, challenger test execution, arbitration, and reporting all run for real. Only the Qodo call is substituted. Replayed output is labelled as replayed. It must reproduce the published benchmark numbers exactly, so replay doubles as the reproducibility check. Because of replay, the demo always works, and because the recordings are the same audit log the benchmark comes from, nothing is staged.

## 15.2 Developers: their own projects

| Mode | How it runs | What the developer gets |
|---|---|---|
| Audit | `npx faultforge audit`, locally | A blind-spot report for their own code |
| Challenge | A GitHub Action on pull requests | One comment per PR backing each Qodo finding with a test, or flagging it as unconfirmed |
| Learn | A scheduled GitHub Action | A pull request proposing Qodo configuration changes for a human to approve |

```bash
npx faultforge audit
```

```yaml
- uses: faultforge/challenge@v1
```

**Audit mode** plants defects in throwaway worktrees, runs a local Qodo review on each one, and runs the project's own test suite. It never opens a pull request and never touches the main branch. Each planted defect lands in one of four cells:

| | Qodo caught it | Qodo missed it |
|---|---|---|
| **Tests caught it** | Double coverage | Tests are the only safety net |
| **Tests missed it** | Review is the only safety net | **Blind spot** |

The blind-spot cell is the hook. It names defect classes that would reach production today and suggests the Qodo rule or the missing test that closes each one. This is mutation testing applied to code review.

**Validating defects on unfamiliar code.** On a user's repository there is no hidden proof test, and some mutations change nothing observable. A planted defect therefore needs evidence before it counts:

- It must compile.
- If at least one existing test fails, the defect is validated.
- If no test fails, Devil's Advocate tries to write a reproducing test. If it succeeds, the defect is a confirmed blind spot, and the user keeps the test.
- If neither happens, it is reported as a possible blind spot, unconfirmed, and it is excluded from every rate.

**Ease of use:**

- Zero configuration by default. It detects the language, test runner, and Qodo setup.
- An optional INVARIANTS.md in plain English gives more targeted defects.
- Generic structural templates work on any TypeScript project: remove a guard clause, flip a comparison, drop an await, delete an authorization check, swallow an error, shift a boundary.
- The answer key lives in the user's home directory, never in the repository, so it never enters Qodo's context.
- Generated tests run in a sandbox with no network access and no credentials.
- A `--budget` flag caps the number of planted defects, and the tool estimates the Qodo review cost before running.

**Limits in v1:** TypeScript and JavaScript only. The challenger needs a project with runnable tests. Audit mode needs the local Qodo review. Where that is unavailable, it falls back to draft pull requests on a fork the user owns.

## 15.3 Built to become an app

The hackathon builds the core of a later product, not a throwaway demo.

- **Core as a library.** One engine package holds targets, review sources, cases, and policy. The command-line tool, the GitHub Action, replay mode, and the Debate Chamber are thin shells around it.
- **Two plug-in interfaces.** A target adapter supports the seed app and any local repository. A review source supports the local Qodo review, Qodo PR comments, and replay.
- **Stable, versioned data.** The case record and audit log schemas carry a version number. A later dashboard reads them unchanged.
- **No hosted service during the hackathon.** Accounts, billing, and a web app wait until afterwards. Building them now would break the scope rule.

| Stage | Who uses it | What they get |
|---|---|---|
| Hackathon | Judges | Published site, Codespace, replay mode |
| Hackathon | Early users | Command-line audit and GitHub Action |
| After the hackathon | Teams | A hosted app with history and trends across repositories, built on the same core and data |
