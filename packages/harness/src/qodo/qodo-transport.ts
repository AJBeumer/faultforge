/**
 * The MCP-over-HTTP session and request plumbing shared by every Qodo API client. A client wraps
 * this with its own allow-list of tool names, so each one only has to decide which tools it trusts
 * itself to call, never how to keep a session alive or retry a dropped one.
 *
 * The key comes from `QODO_API_KEY`, or from the file named in `QODO_KEY_FILE`. It is never printed.
 */
import { readFileSync } from "node:fs";

const URL = "https://sdk.qodo.ai/v1/tools/mcp/";

/** How long one request may take before it counts as failed, so a stalled call can't hang a caller. */
const REQUEST_TIMEOUT_MS = 60_000;

export function apiKey(env: NodeJS.ProcessEnv = process.env): string {
  // `||`, not `??`: an empty QODO_API_KEY must not block the key file.
  const key = env.QODO_API_KEY?.trim() || (env.QODO_KEY_FILE && readFileSync(env.QODO_KEY_FILE, "utf8"));
  if (!key?.trim()) throw new Error("Set QODO_API_KEY, or QODO_KEY_FILE to the path of the key file.");
  return key.trim();
}

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
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (result.isError) throw new Error(`Qodo tool error: ${(text ?? "(no text)").slice(0, 500)}`);
  // No text is no answer, never the data `null`.
  if (text === undefined) throw new Error("Qodo tool answered with no text");
  return JSON.parse(text);
}

/**
 * A failure of the connection or protocol, never a tool's own error answer. Only this kind can start a new
 * session: a tool's answer is Qodo's data, not a sign the connection was lost, however its text reads.
 */
export class TransportError extends Error {}

/**
 * True when Qodo forgot a session it had accepted: a 404, or an error naming "session". Qodo drops long
 * sessions, so the answer is a new session and one more try, not a failed poll.
 */
export function isSessionLost(error: unknown): boolean {
  if (!(error instanceof TransportError)) return false;
  return /HTTP 404\b/.test(error.message) || /\bsession\b/i.test(error.message);
}

/** One MCP session to Qodo. Which tools are safe to call is each client's allow-list, not this class's. */
export class QodoTransport {
  private session?: string;
  private id = 0;
  private ready?: Promise<void>;
  private readonly key = apiKey();
  /**
   * The last response body as received, so a caller can save it even when it fails to parse. An unusable
   * body is wrapped with its HTTP status, so the status is saved too.
   */
  lastRaw = "";
  /**
   * The failed bodies a session recovery replaced in the last call, oldest first. The retry overwrites
   * `lastRaw`, so without this the failure that caused it would be lost as evidence.
   */
  lastRecoveredRaw: string[] = [];

  /** No allow-list here: the client checked the tool name before calling. */
  async callTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Cleared first, so a failed call never leaves the previous answer looking like its own.
    this.lastRaw = "";
    this.lastRecoveredRaw = [];
    await this.ensureStarted();
    try {
      return await this.toolCall(tool, args);
    } catch (error) {
      const hadSession = this.session !== undefined;
      if (!hadSession || !isSessionLost(error)) throw error;
      this.lastRecoveredRaw.push(this.lastRaw);
      this.session = undefined;
      this.ready = undefined;
      await this.ensureStarted();
      return await this.toolCall(tool, args);
    }
  }

  private async toolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.rpc("tools/call", { name: tool, arguments: args })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    return parseToolText(result);
  }

  /** A failed start is forgotten, so the next call connects again instead of repeating the old failure. */
  private ensureStarted(): Promise<void> {
    this.ready ??= this.start().catch((error: unknown) => {
      this.ready = undefined;
      this.session = undefined;
      throw error;
    });
    return this.ready;
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
    // Kept before anything is checked, so any failure below still leaves it saved. The key is taken out:
    // a body that echoed it must not carry it into saved evidence.
    const text = (await res.text()).replaceAll(this.key, "***");
    this.lastRaw = text;
    if (!res.ok) {
      this.lastRaw = JSON.stringify({ httpStatus: res.status, body: text });
      throw new TransportError(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    if (notify || !text.trim()) return undefined;
    let json: { result?: unknown; error?: unknown };
    try {
      json = parseRpcBody(text);
    } catch (error) {
      this.lastRaw = JSON.stringify({ httpStatus: res.status, body: text });
      throw new TransportError(
        `${method}: could not parse the response (HTTP ${res.status}): ${(error as Error).message}`,
      );
    }
    if (json.error) {
      throw new TransportError(`${method}: ${JSON.stringify(json.error).replaceAll(this.key, "***")}`);
    }
    return json.result;
  }
}
