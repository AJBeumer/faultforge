# 10. Qodo integration

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

## Primary path and Day 2 acceptance check

The documented local review command with JSON output is the primary candidate. Documentation also describes possible closed-preview gating, so nothing is assumed until an authenticated end-to-end run succeeds.

1. Confirm the trial covers the full 30 days and includes command-line review and enough review quota for the benchmark.
2. Inspect the installed CLI version and the review command's help.
3. Verify authentication and that local review is permitted for this account.
4. Review a known change against the correct base commit.
5. Save the raw JSON. Inspect finding ids, locations, categories, status, and metadata.
6. Run the same diff three times. Record runtime, quota use, and variance between runs.
7. Document the outcome as working, gated, or unavailable.

## Fallback

If local structured review is unusable, open normal GitHub PRs and ingest Qodo's posted review through supported GitHub interfaces. Store the reviewed commit and completion status. Do not infer machine-readable fields that are absent.

## Rules that apply on either path

- Label the review path, configuration version, and date on every case. Never mix paths in one accuracy comparison.
- Qodo's models and prompts will change during the month. Report results stratified by date window when they differ.
- Freeze the Qodo configuration for the baseline. A configuration change starts a new benchmark version.
- Configure Qodo's normal PR review so that arbiter-published findings do not duplicate it. Do not assume published comments can be intercepted.
- Map Qodo's categories to the arbiter's "security-critical" set explicitly and version that mapping.
