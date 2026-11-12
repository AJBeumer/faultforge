/**
 * A client for Qodo's local/pre-PR review tools (MCP over HTTP): submitting an uncommitted diff for
 * review and reading back its operation status and result. Scoped to exactly these three tools, the
 * same way `QodoApi` is scoped to its read-only ones — a caller can't reach dismiss, mark-implemented
 * or any other write tool through this client.
 *
 * `start-pre-pr-review` isn't read-only (it creates a review run), but it isn't destructive either:
 * it only ever adds a new local review, the same way opening a pull request adds a new PR review.
 *
 * The key comes from `QODO_API_KEY`, or from the file named in `QODO_KEY_FILE`. It is never printed.
 */
import { QodoTransport } from "./qodo-transport.ts";

/** The only tools this client will call: submit a local review, poll it, and read its result back. */
export const LOCAL_REVIEW_TOOLS = new Set([
  "start-pre-pr-review",
  "get-managed-agent-operation",
  "get-managed-agent-result",
  "cancel-managed-agent-operation",
]);

export class QodoLocalReviewApi {
  private readonly transport = new QodoTransport();

  get lastRaw(): string {
    return this.transport.lastRaw;
  }

  get lastRecoveredRaw(): string[] {
    return this.transport.lastRecoveredRaw;
  }

  /** Calls one allow-listed local-review tool and returns its text result parsed as JSON. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!LOCAL_REVIEW_TOOLS.has(tool)) throw new Error(`Refusing ${tool}: not on the local-review allow-list.`);
    return this.transport.callTool(tool, args);
  }
}
