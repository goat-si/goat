// Synthetic OpenCode 2 HTTP + SSE double; the pinned Promise SDK decodes every frame.
import type { OpenCode2FakeModule } from "../../src/engines/opencode2/runtime.ts";

export const startFakeServer: OpenCode2FakeModule["startFakeServer"] = async ({ password, launch }) => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined; let sequence = 0; let closed = false;
  const version = launch?.env?.GOAT2_ENGINE_HELPER_FAKE_OPENCODE2_VERSION || process.env.GOAT2_ENGINE_HELPER_FAKE_OPENCODE2_VERSION || "2.0.28";
  const send = (type: string, data: Record<string, unknown>, durable = true) => {
    const n = ++sequence; const frame = { id: `event-${n}`, created: n, type, data, ...(durable ? { durable: { aggregateID: "session-v2", seq: n, version: type === "session.tool.success" ? 2 : 1 } } : {}) };
    if (!closed) stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return {
    url: "http://127.0.0.1:9876", onExit() {}, close() { closed = true; try { stream?.close(); } catch {} },
    async fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) return new Response(null, { status: 401 });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (url.pathname === "/api/info") return json({ version, pid: 123, urls: [], paths: { tmp: "/tmp" } });
      if (url.pathname === "/api/event") {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/api/model") return json({ location: { directory: "/tmp" }, data: [{ id: "model", modelID: "model", providerID: "test", name: "Test model", variants: [], time: { released: 1 }, cost: [], status: "active", limit: { input: 1000, context: 2000, output: 100 } }] });
      if (url.pathname === "/api/provider") return json({ location: { directory: "/tmp" }, data: [{ id: "test", name: "Test" }] });
      if (url.pathname === "/api/session/active") return json({ data: {} });
      if (url.pathname === "/api/session" && method === "POST") return json({ data: { id: "session-v2", model: body.model, location: { directory: "/tmp" } } });
      if (url.pathname === "/api/session/session-v2/prompt" && method === "POST") {
        const id = body.id;
        setImmediate(() => {
          if (typeof body.text === "string" && body.text.includes("bad-terminal")) { send("session.execution.succeeded", {}); return; }
          send("session.execution.started", { sessionID: "session-v2" });
          send("session.reasoning.delta", { sessionID: "session-v2", assistantMessageID: "assistant-v2", ordinal: 0, delta: "Think" }, false);
          send("session.reasoning.ended", { sessionID: "session-v2", assistantMessageID: "assistant-v2", ordinal: 0, text: "Think" });
          send("session.text.delta", { sessionID: "session-v2", assistantMessageID: "assistant-v2", ordinal: 0, delta: "Hello" }, false);
          send("session.text.ended", { sessionID: "session-v2", assistantMessageID: "assistant-v2", ordinal: 0, text: "Hello world" });
          send("session.tool.input.started", { sessionID: "session-v2", assistantMessageID: "assistant-v2", id: "tool-v2", name: "shell" });
          send("session.tool.called", { sessionID: "session-v2", assistantMessageID: "assistant-v2", id: "tool-v2", input: { command: "pwd" }, executed: true });
          send("session.tool.success", { sessionID: "session-v2", assistantMessageID: "assistant-v2", id: "tool-v2", executed: true, content: [{ type: "text", text: "/tmp" }] });
          send("session.step.ended", { sessionID: "session-v2", assistantMessageID: "assistant-v2", finish: "stop", cost: 0, tokens: { input: 7, output: 8, reasoning: 2, cache: { read: 3, write: 4 } } });
          send("session.execution.succeeded", { sessionID: "session-v2" });
        });
        return json({ data: { id, sessionID: "session-v2", type: "user", time: { created: 1 }, payload: { text: body.text }, delivery: body.delivery ?? "queue" } });
      }
      if (url.pathname.startsWith("/api/experimental/mcp/")) return new Response(null, { status: 204 });
      if (url.pathname === "/api/session/session-v2/interrupt") return json({ data: { interrupted: true } });
      throw new Error(`Unexpected fake endpoint: ${method} ${url.pathname}`);
    },
  };
};
