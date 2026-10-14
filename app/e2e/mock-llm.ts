/**
 * A stand-in model provider for the end-to-end suite: an OpenAI-compatible
 * `/v1/chat/completions` endpoint that streams scripted replies. The binary under
 * test reaches it through an ordinary `models.json` provider, so a test exercises the
 * same HTTP, streaming, tool-call and memory code a real provider would.
 *
 * Every request is recorded, so a test can assert on what the binary sent: the
 * system prompt (recalled memory), tool results (what a command printed), headers.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
/** `{ status }` answers the request with that HTTP error instead (a bad key, an outage). */
export type Reply = { text: string } | { tools: ToolCall[]; text?: string } | { status: number; error?: string };

export interface ChatRequest {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  stream?: boolean;
}

/** What the model "says" next. Async scripts can hold a turn open until a test releases it.
 * `agent` requests carry tools; side calls (reflection, titles) do not. */
export type Script = (req: ChatRequest, ctx: { agentTurn: number; all: ChatRequest[] }) => Reply | Promise<Reply>;

export interface MockLLM {
  url: string;
  requests: ChatRequest[];
  /** Requests that offered tools: the agent loop, as opposed to reflection and other side calls. */
  agentRequests(): ChatRequest[];
  stop(): void;
}

/** Plain text of a message, whatever shape its content takes. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("");
  return content == null ? "" : JSON.stringify(content);
}

/** The text of every tool result the binary sent back, in order. */
export function toolResults(req: ChatRequest): string[] {
  return req.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
}

export function systemPrompt(req: ChatRequest): string {
  return req.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
}

function chunk(delta: object, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function sse(reply: Exclude<Reply, { status: number }>): string {
  let out = chunk({ role: "assistant" });
  if ("tools" in reply) {
    if (reply.text) out += chunk({ content: reply.text });
    reply.tools.forEach((t, i) => {
      out += chunk({ tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] });
    });
    out += chunk({}, "tool_calls");
  } else {
    // Split the text so the client really streams it.
    for (const piece of reply.text.match(/.{1,12}/gs) ?? [""]) out += chunk({ content: piece });
    out += chunk({}, "stop");
  }
  out += `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
  return out + "data: [DONE]\n\n";
}

export function startMockLLM(script: Script): MockLLM {
  const requests: ChatRequest[] = [];
  let agentTurn = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // Tests own their deadlines; a held reply must not expire after Bun's idle timeout.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-1", object: "model" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = (await req.json()) as ChatRequest;
      requests.push(body);
      const isAgent = (body.tools?.length ?? 0) > 0;
      let reply: Reply;
      try {
        reply = isAgent ? await script(body, { agentTurn: agentTurn++, all: requests }) : { text: "[]" };
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
      if ("status" in reply) return Response.json({ error: { message: reply.error ?? `mock error ${reply.status}`, type: "mock_error" } }, { status: reply.status });
      if (body.stream === false) {
        const message = "tools" in reply
          ? { role: "assistant", content: reply.text ?? null, tool_calls: reply.tools.map((t, i) => ({ id: `call_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) }
          : { role: "assistant", content: reply.text };
        return Response.json({ id: "mock", object: "chat.completion", choices: [{ index: 0, message, finish_reason: "tools" in reply ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      }
      return new Response(sse(reply), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    agentRequests: () => requests.filter((r) => (r.tools?.length ?? 0) > 0),
    stop: () => server.stop(true),
  };
}

/** A script from a list: the n-th agent request gets the n-th reply; after the list, a closing line. */
export function sequence(...replies: Reply[]): Script {
  return (_req, { agentTurn }) => replies[agentTurn] ?? { text: "done" };
}
