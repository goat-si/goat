// Local SDK double: each message selects a deterministic interaction, no network or login.
let counter = 0;
export async function createAgentPlatform() {
  return { store: {}, checkpointStore: {}, eventStore: undefined, eventNotifier: undefined,
    prewarmLocalWorkspace: async () => async () => {} };
}
export class CursorAgentPlatform {
  async createAgent(options: any) {
    if (options.mcpServers?.goat?.type !== "http" || options.mcpServers.goat.headers?.Authorization !== "Bearer fake-mcp") throw new Error("MCP mismatch");
    return this.agent("cursor-new");
  }
  async resumeAgent(id: string) { return this.agent(id); }
  private agent(agentId: string) {
    return { agentId, close() {}, async send(message: string, options: any) {
      if (message === "reject") throw new Error("scripted failure");
      const id = `run-${++counter}`;
      let resolve: (value: any) => void = () => {};
      const finished = new Promise(r => { resolve = r; });
      const run = { id, agentId, async wait() { return finished; }, async cancel() { resolve({ id, status: "cancelled" }); }, async steer(text: string) { return text === "refuse" ? "revert_to_followup" : "complete_delivered"; } };
      if (!message.endsWith("hang")) setImmediate(async () => {
        await options.onDelta({ update: { type: "text-delta", text: "hello " } });
        await options.onDelta({ update: { type: "text-delta", text: "world" } });
        await options.onDelta({ update: { type: "tool-call-completed", callId: "call-1", toolCall: { type: "mcp", args: { providerIdentifier: "goat", toolName: "goat_describe", args: {} }, result: { status: "success", value: {} } } } });
        resolve({ id, status: message === "fail" ? "error" : "finished" });
      });
      return run;
    } };
  }
}
export const Cursor = { me: async () => ({ apiKeyName: "" }), models: { list: async () => [{ id: "test-model", displayName: "Test model" }] } };
