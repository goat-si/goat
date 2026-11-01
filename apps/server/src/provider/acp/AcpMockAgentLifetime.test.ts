// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

describe("acp-mock-agent", () => {
  it("exits when its parent closes stdin", async () => {
    const agent = NodeChildProcess.spawn(process.execPath, [mockAgentPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      // A JSON-RPC answer proves the agent is up before stdin closes.
      agent.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
      );
      await NodeEvents.EventEmitter.once(agent.stdout, "data");
      const exited = NodeEvents.EventEmitter.once(agent, "exit");
      agent.stdin.end();
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      if (agent.exitCode === null && agent.signalCode === null) agent.kill("SIGKILL");
    }
  });
});
