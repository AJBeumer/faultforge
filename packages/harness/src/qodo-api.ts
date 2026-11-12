/**
 * A read-only client for Qodo's API (MCP over HTTP). It can only call the tools on the allow-list
 * below; anything that could change state (dismiss, resolve, post, approve…) is refused here, so a
 * caller can't do it by mistake.
 *
 * The key comes from `QODO_API_KEY`, or from the file named in `QODO_KEY_FILE`. It is never printed.
 */
import { QodoTransport } from "./qodo-transport.ts";

export { isSessionLost, parseRpcBody, parseToolText, TransportError } from "./qodo-transport.ts";

/** The only tools this client will call. All of them only read. */
export const READ_ONLY_TOOLS = new Set([
  "get-pr-review-findings",
  "rules-list",
  "review-skills-list",
  "cross-repo-overview",
  "cross-repo-relations",
  "litegit-search-repos",
]);

export class QodoApi {
  private readonly transport = new QodoTransport();

  get lastRaw(): string {
    return this.transport.lastRaw;
  }

  get lastRecoveredRaw(): string[] {
    return this.transport.lastRecoveredRaw;
  }

  /** Calls one allow-listed tool and returns its text result parsed as JSON. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!READ_ONLY_TOOLS.has(tool)) throw new Error(`Refusing ${tool}: not on the read-only allow-list.`);
    return this.transport.callTool(tool, args);
  }
}
