/**
 * A client for Qodo's local review tools (MCP over HTTP): submit an uncommitted diff, poll it, read its result,
 * or cancel it. It is held to these four tools so a caller can't reach dismiss, mark-implemented or any other
 * write tool through it.
 *
 * `start-pre-pr-review` isn't read-only, but it only adds a new local review, the way opening a pull request
 * adds a review. It changes nothing that exists.
 *
 * The key comes from `QODO_API_KEY`, or from the file named in `QODO_KEY_FILE`. It is never printed.
 */
import { QodoTransport } from "./qodo-transport.ts";

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

  /** Returns the tool's text result parsed as JSON. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!LOCAL_REVIEW_TOOLS.has(tool)) throw new Error(`Refusing ${tool}: not on the local-review allow-list.`);
    return this.transport.callTool(tool, args);
  }
}
