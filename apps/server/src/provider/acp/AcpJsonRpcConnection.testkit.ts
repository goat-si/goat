// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
export const mockAgentCommand = process.execPath;
export const mockAgentArgs = [mockAgentPath];
export const mockRuntimeOptions = {
  spawn: { command: mockAgentCommand, args: mockAgentArgs },
  cwd: process.cwd(),
  clientInfo: { name: "t3-test", version: "0.0.0" },
  authMethodId: "test",
} satisfies AcpSessionRuntime.AcpSessionRuntimeOptions;
