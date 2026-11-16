# qodo

Talking to Qodo, read-only.

- `qodo-transport.ts`: the MCP-over-HTTP session every Qodo client shares.
- `qodo-api.ts`: a PR's review through Qodo's managed API. `qodo-review.ts`: that review and its pure reads.
- `qodo-local-review-api.ts`: the local-review API `review:local` uses.
- `qodo-check.ts`: compares Qodo's live configuration with the latest snapshot in private storage.

Entry points: `npm run qodo:check` (`qodo-check.ts`).

Uses: `shared`.
