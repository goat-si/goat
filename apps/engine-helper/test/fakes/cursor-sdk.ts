// Local SDK double: each message selects a deterministic interaction, no network or login.
let counter = 0;
export async function createAgentPlatform() {
  return { store: {}, checkpointStore: {}, eventStore: undefined, eventNotifier: undefined,
    prewarmLocalWorkspace: async () => async () => {} };
}
export class CursorAgentPlatform {
  cancelled = false;
  async listRuns(_id: string, options: { cursor?: string }) {
    return options.cursor ? { items: [{ id: "abandoned", status: "running" }] } : { items: [], nextCursor: "page2" };
  }
  async cancelRun(id: string) { if (id !== "abandoned") throw new Error("wrong run"); this.cancelled = true; }
  async createAgent(options: any) {
    if (options.mcpServers?.goat?.type !== "http" || options.mcpServers.goat.headers?.Authorization !== "Bearer fake-mcp") throw new Error("MCP mismatch");
    return this.agent("cursor-new");
  }
  async resumeAgent(id: string) { return this.agent(id); }
  private agent(agentId: string) {
    const platform = this;
    return { agentId, close() {}, async send(message: string, options: any) {
      if (message === "recover" && !platform.cancelled) throw new Error("already has active run");
      if (message === "reject") throw new Error("scripted failure");
      const id = `run-${++counter}`;
      let resolve: (value: any) => void = () => {};
      const finished = new Promise(r => { resolve = r; });
      const run = { id, agentId, async wait() { return finished; }, async cancel() { resolve({ id, status: "cancelled" }); }, async steer(text: string) { return text === "refuse" ? "revert_to_followup" : "complete_delivered"; } };
      if (message === "early") await options.onDelta({ update: { type: "text-delta", text: "early " } });
      if (!message.endsWith("hang")) setImmediate(async () => {
        await options.onDelta({ update: { type: "text-delta", text: message === "secret" ? "fake-" : "hello " } });
        await options.onDelta({ update: { type: "text-delta", text: message === "secret" ? "key" : "world" } });
        if (message === "projects") {
          await options.onDelta({ update: { type: "thinking-delta", text: "reason" } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "cmd", toolCall: { type: "shell", args: { command: "ls" }, result: { status: "success", value: { exitCode: 0, stdout: "", stderr: "" } } } } });
          await options.onDelta({ update: { type: "tool-call-completed", callId: "edit", toolCall: { type: "edit", args: { path: "a.ts" }, result: { status: "success", value: {} } } } });
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
export const Cursor = { me: async () => ({ apiKeyName: "" }), models: { list: async () => [{ id: "test-model", displayName: "Test model" }] } };
