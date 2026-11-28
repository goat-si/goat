// Local SDK double: each message selects a deterministic interaction, no network or login.
let counter = 0;
let checkpoint: unknown;
export async function createAgentPlatform() {
  return { store: {}, checkpointStore: { loadLatest: async () => { if (checkpoint === "throw") throw new Error("unavailable"); if (checkpoint === "hang") return new Promise(() => {}); return checkpoint; } }, eventStore: undefined, eventNotifier: undefined,
    prewarmLocalWorkspace: async () => async () => {} };
}
export class CursorAgentPlatform {
  cancelled = false;
  async listRuns(_id: string, options: { cursor?: string }) {
    return options.cursor ? { items: [{ id: "abandoned", status: "running" }] } : { items: [], nextCursor: "page2" };
  }
  async cancelRun(id: string) { if (id !== "abandoned") throw new Error("wrong run"); this.cancelled = true; }
  async createAgent(options: any) {
    if (process.env.GOAT_TEST_DIAGNOSTIC) { process.stderr.write("fake-"); process.stderr.write("key fake-mcp\n"); }
    if (process.env.GOAT_TEST_EXPECT_KEY && (options.apiKey ?? "none") !== process.env.GOAT_TEST_EXPECT_KEY) throw new Error("API key scope mismatch");
    if (process.env.GOAT_TEST_EXPECT_TOKEN && (process.env.CURSOR_AUTH_TOKEN ?? "none") !== process.env.GOAT_TEST_EXPECT_TOKEN) throw new Error("auth token scope mismatch");
    if (process.env.GOAT_TEST_NO_MCP !== "1" && (options.mcpServers?.goat?.type !== "http" || options.mcpServers.goat.headers?.Authorization !== "Bearer fake-mcp")) throw new Error("MCP mismatch");
    return this.agent("cursor-new");
  }
  async resumeAgent(id: string) { return this.agent(id); }
  private agent(agentId: string) {
    const platform = this;
    return { agentId, close() {}, async send(input: string | { text: string; images?: unknown[] }, options: any) {
      if (process.env.GOAT_TEST_NO_MCP === "1" && JSON.stringify(options.mcpServers) !== "{}") throw new Error("MCP was not cleared");
      const message = typeof input === "string" ? input : input.text;
      checkpoint = message === "usage" ? { tokenDetails: { usedTokens: 123, maxTokens: 1000 } } : message === "bad-usage" ? { tokenDetails: { usedTokens: -1, maxTokens: 1000 } } : message === "usage-error" ? "throw" : message === "usage-stuck" ? "hang" : undefined;
      if (message === "switch-model" && options.model?.id !== "new-model") throw new Error("model was not switched");
      if (message === "crash") setImmediate(() => process.exit(42));
      if (message === "recover" && !platform.cancelled) throw new Error("already has active run");
      if (message === "reject") throw new Error("scripted failure");
      const id = `run-${++counter}`;
      let cancelCount = 0;
      let resolve: (value: any) => void = () => {};
      let reject: (reason: Error) => void = () => {};
      const finished = new Promise((r, j) => { resolve = r; reject = j; });
      const run = { id, agentId, async wait() { return finished; }, async cancel() {
        if (message === "cancel-retry-hang" && ++cancelCount === 1) throw new Error("temporary cancel failure");
        if (message === "wait-done-cancel-hang") { resolve({ id, status: "finished" }); return new Promise<void>(() => {}); }
        if (message === "wait-error-cancel-hang") { reject(new Error("cancelled")); await new Promise<void>(r => setImmediate(r)); return; }
        if (message === "cancel-fails-hang") { resolve({ id, status: "finished" }); await new Promise<void>(r => setImmediate(r)); throw new Error("cancel failed"); }
        resolve({ id, status: "cancelled" });
      }, async steer(text: string) { return text === "refuse" ? "revert_to_followup" : "complete_delivered"; } };
      if (message === "early") await options.onDelta({ update: { type: "text-delta", text: "early " } });
      if (message !== "crash" && !message.endsWith("hang")) setImmediate(async () => {
        if (message.startsWith("verify image")) {
          if (typeof input === "string" || JSON.stringify(input.images) !== JSON.stringify([{ data: Buffer.from("fake-image").toString("base64"), mimeType: "image/png" }])) throw new Error("image mismatch");
          await options.onDelta({ update: { type: "text-delta", text: "image verified" } });
        } else if (message.startsWith("check attachments")) {
          if (!message.includes('[Attached file "report.txt" is saved at: /tmp/report.txt]') || !message.includes('[Attached file "lost.txt" is unavailable:')) throw new Error("attachment prompt mismatch");
          await options.onDelta({ update: { type: "text-delta", text: "attachments verified" } });
        } else {
          await options.onDelta({ update: { type: "text-delta", text: message === "secret" ? "fake-" : "hello " } });
          await options.onDelta({ update: { type: "text-delta", text: message === "secret" ? "key" : "world" } });
        }
        if (message === "content-secret") {
          await options.onDelta({ update: { type: "thinking-delta", text: "fake-" } });
          await options.onDelta({ update: { type: "thinking-delta", text: "key" } });
        }
        if (message === "projects") {
          await options.onDelta({ update: { type: "thinking-delta", text: "reason" } });
          await options.onDelta({ update: { type: "partial-tool-call", callId: "plan", toolCall: { type: "createPlan", args: { plan: "do " } } } });
          await options.onDelta({ update: { type: "partial-tool-call", callId: "plan", toolCall: { type: "createPlan", args: { plan: "do work" } } } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "plan", toolCall: { type: "createPlan", args: { plan: "do work" } } } });
          await options.onDelta({ update: { type: "tool-call-started", callId: "cmd", toolCall: { type: "shell", args: { command: "ls" } } } });
          await options.onDelta({ update: { type: "shell-output-delta", event: { toolCallId: "cmd", case: "stdout", value: { data: "file" } } } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "cmd", toolCall: { type: "shell", args: { command: "ls" }, result: { status: "success", value: { exitCode: 0, stdout: "file", stderr: "" } } } } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "edit", toolCall: { type: "edit", args: { path: "a.ts" }, result: { status: "success", value: { diffString: "+x", linesAdded: 1, linesRemoved: 0 } } } } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "todos", toolCall: { type: "updateTodos", args: { todos: [{ content: "work", status: "completed" }] } } } });
          await options.onDelta({ update: { type: "tool-call-started", callId: "task", toolCall: { type: "task", args: { description: "research", prompt: "inspect" } } } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "task", toolCall: { type: "task", args: { description: "research", prompt: "inspect" }, result: { status: "success", value: { resultSuffix: "done" } } } } });
        }
        await options.onDelta({ update: { type: "tool-call-completed", callId: "call-1", toolCall: { type: "mcp", args: { providerIdentifier: "goat", toolName: "goat_describe", args: {} }, result: { status: "success", value: {} } } } });
        resolve({ id, status: message === "fail" ? "error" : "finished", ...(message === "fail" ? { error: { code: "PRO_USER_USAGE_LIMIT" } } : {}) });
      });
      return run;
    } };
  }
}
export const Cursor = { me: async ({ apiKey }: { apiKey?: string }) => {
  if (apiKey === "bad-key") throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!apiKey && process.env.GOAT_TEST_SIGNED_IN !== "1") throw Object.assign(new Error("offline"), { name: "NetworkError" });
  return { apiKeyName: "" };
}, models: { list: async () => [{ id: "test-model", displayName: "Test model" }] } };
