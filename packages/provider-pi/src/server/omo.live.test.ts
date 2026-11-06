// @effect-diagnostics nodeBuiltinImport:off -- drives an installed OmO binary over Pi RPC with GOAT's extension.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { assert, describe, it } from "@effect/vitest";
import {
  GOAT_PI_PROFILE_ENV,
  GOAT_PI_RUNTIME_MODE_ENV,
  GOAT_SUBAGENT_GATE_ENV,
  PI_GOAT_MCP_EXTENSION_SOURCE,
} from "./mcpExtensionSource.ts";

// GOAT_TEST_KEEP_PROVIDER_ENV=1 keeps GOAT_OMO_BIN through the shared test setup.
const binary = process.env.GOAT_OMO_BIN ?? "";

const evalCell = (code: string) => ({ action: "run", language: "js", code, summary: "fixture" });

// OmO exposes bash only inside eval cells; host tool calls from a cell still reach tool_call hooks.
const SCRIPT = [
  { name: "task", arguments: { description: "child", prompt: "say hi" } },
  { name: "eval", arguments: evalCell('await tool.task({ description: "child", prompt: "hi" })') },
  { name: "eval", arguments: evalCell('await tool.bash({ command: "touch marker" })') },
] as const;

interface ToolMessage {
  readonly role: string;
  readonly content?: unknown;
}

const toolText = (message: ToolMessage) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

describe.skipIf(binary === "")("OmO through GOAT's Pi extension", () => {
  it("blocks native spawns and asks before commands in approval-required mode", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-omo-live-"));
    const toolResults: string[] = [];
    const server = NodeHttp.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        readonly messages: ReadonlyArray<ToolMessage>;
      };
      const tools = body.messages.filter((message) => message.role === "tool");
      if (tools.length > toolResults.length) toolResults.push(toolText(tools[tools.length - 1]!));
      const step = SCRIPT[tools.length];
      const delta =
        step === undefined
          ? { content: "Done." }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "call_" + tools.length,
                  type: "function",
                  function: { name: step.name, arguments: JSON.stringify(step.arguments) },
                },
              ],
            };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-1",
            choices: [
              { index: 0, delta, finish_reason: step === undefined ? "stop" : "tool_calls" },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    const agentDir = NodePath.join(root, "agent");
    const workDir = NodePath.join(root, "work");
    await NodeFSP.mkdir(agentDir, { recursive: true });
    await NodeFSP.mkdir(workDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "goat-mock": {
            baseUrl: "http://127.0.0.1:" + address.port + "/v1",
            api: "openai-completions",
            apiKey: "fixture",
            models: [{ id: "mock-1", name: "Mock model", contextWindow: 200_000, maxTokens: 4096 }],
          },
        },
      }),
    );
    // Keeps OmO's desktop engine from registering, so no GUI process can start.
    await NodeFSP.writeFile(
      NodePath.join(agentDir, "settings.json"),
      JSON.stringify({ computer: { enabled: false } }),
    );
    const extension = NodePath.join(root, "goat-extension.ts");
    await NodeFSP.writeFile(extension, PI_GOAT_MCP_EXTENSION_SOURCE);
    const gate = NodePath.join(root, "subagents");
    await NodeFSP.writeFile(gate, "off");

    const child = NodeChildProcess.spawn(
      binary,
      ["--mode", "rpc", "--provider", "goat-mock", "--model", "mock-1", "--extension", extension],
      {
        cwd: workDir,
        env: {
          HOME: root,
          PATH: process.env.PATH,
          OMO_CODING_AGENT_DIR: agentDir,
          XDG_CONFIG_HOME: NodePath.join(root, "config"),
          XDG_CACHE_HOME: NodePath.join(root, "cache"),
          XDG_DATA_HOME: NodePath.join(root, "data"),
          [GOAT_PI_PROFILE_ENV]: "omo",
          [GOAT_PI_RUNTIME_MODE_ENV]: "approval-required",
          [GOAT_SUBAGENT_GATE_ENV]: gate,
          // OmO's RPC host otherwise lingers 15 minutes after its client leaves.
          SENPI_RPC_HOST_IDLE_EXIT_MS: "1",
          SENPI_RPC_HOST_EMPTY_EXIT_MS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const confirms: string[] = [];
    const seen: string[] = [];
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    try {
      const lines = NodeReadline.createInterface({ input: child.stdout });
      child.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: "go" }) + "\n");
      for await (const line of lines) {
        const frame = JSON.parse(line) as Record<string, unknown>;
        seen.push(line.slice(0, 300));
        if (frame.type === "extension_ui_request" && frame.method === "confirm") {
          confirms.push(String(frame.title));
          child.stdin.write(
            JSON.stringify({ type: "extension_ui_response", id: frame.id, confirmed: true }) + "\n",
          );
        }
        if (frame.type === "response" && frame.command === "prompt" && frame.success === false) {
          throw new Error("prompt failed: " + String(frame.error));
        }
        if (frame.type === "agent_settled") break;
      }
      assert.lengthOf(toolResults, 3, seen.join("\n") + "\nSTDERR " + stderr);
      assert.include(toolResults[0], "allows no native subagents");
      assert.include(toolResults[1], "allows no native subagents", toolResults[1]);
      assert.deepEqual(
        confirms,
        ["Allow eval?", "Allow eval?", "Allow bash?"],
        JSON.stringify(toolResults),
      );
      await NodeFSP.access(NodePath.join(workDir, "marker"));
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // The detached RPC host may still be flushing session files as it exits.
      await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
