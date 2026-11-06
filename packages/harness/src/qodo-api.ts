/**
 * A read-only client for Qodo's API (MCP over HTTP). It can only call the tools on the allow-list
 * below; anything that could change state (dismiss, resolve, post, approve…) is refused here, so a
 * caller can't do it by mistake.
 *
 * The key comes from `QODO_API_KEY`, or from the file named in `QODO_KEY_FILE`. It is never printed.
 */
import { readFileSync } from "node:fs";

const URL = "https://sdk.qodo.ai/v1/tools/mcp/";

/** The only tools this client will call. All of them only read. */
export const READ_ONLY_TOOLS = new Set([
  "get-pr-review-findings",
  "rules-list",
  "review-skills-list",
  "cross-repo-overview",
  "litegit-search-repos",
]);

function apiKey(): string {
  const key =
    process.env.QODO_API_KEY ?? (process.env.QODO_KEY_FILE && readFileSync(process.env.QODO_KEY_FILE, "utf8"));
  if (!key?.trim()) throw new Error("Set QODO_API_KEY, or QODO_KEY_FILE to the path of the key file.");
  return key.trim();
}

/** How long one request may take before it counts as failed, so a stalled call can't hang a caller. */
const REQUEST_TIMEOUT_MS = 60_000;

/** A JSON-RPC response body: plain JSON (whitespace allowed) or server-sent events, possibly multi-line. */
export function parseRpcBody(text: string): { result?: unknown; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const events = trimmed.split(/\n\s*\n/);
  for (const event of events.reverse()) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length) return JSON.parse(data.join("\n"));
  }
  throw new Error("No JSON-RPC message in the response");
}

/** A tool result's JSON. A tool-level error is thrown, never returned as if it were data. */
export function parseToolText(result: { isError?: boolean; content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.find((c) => c.type === "text")?.text ?? "null";
  if (result.isError) throw new Error(`Qodo tool error: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

export class QodoApi {
  private session?: string;
  private id = 0;
  private ready?: Promise<void>;
  private readonly key = apiKey();
  /** The raw text of the last tool result, kept so a caller can save it even if parsing fails. */
  lastRaw = "";

  /** Calls one allow-listed tool and returns its text result parsed as JSON. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!READ_ONLY_TOOLS.has(tool)) throw new Error(`Refusing ${tool}: not on the read-only allow-list.`);
    // Cleared first, so a failed call never leaves the previous answer looking like its own.
    this.lastRaw = "";
    // A failed start is forgotten, so the next call connects again instead of repeating the old failure.
    this.ready ??= this.start().catch((error: unknown) => {
      this.ready = undefined;
      this.session = undefined;
      throw error;
    });
    await this.ready;
    const result = (await this.rpc("tools/call", { name: tool, arguments: args })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    this.lastRaw = JSON.stringify(result);
    return parseToolText(result);
  }

  private async start() {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "faultforge", version: "1" },
    });
    await this.rpc("notifications/initialized", {}, true);
  }

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.id, method, params };
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.session ??= res.headers.get("mcp-session-id") ?? undefined;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300).replaceAll(this.key, "***")}`);
    if (notify || !text.trim()) return undefined;
    const json = parseRpcBody(text);
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error).replaceAll(this.key, "***")}`);
    return json.result;
  }
}
