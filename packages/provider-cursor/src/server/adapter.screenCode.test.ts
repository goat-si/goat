import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

import { cursorMcpServers, makeCursorAgentOptions } from "./adapter.ts";

it("gives Cursor the GOAT MCP server and goat_screen_run guide for an attached turn", () => {
  const threadId = ThreadId.make("thread-screen");
  const config = {
    environmentId: EnvironmentId.make("env-screen"),
    threadId,
    providerSessionId: "session-screen",
    providerInstanceId: ProviderInstanceId.make("cursor"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer test",
    browserToolsAvailable: true,
    builtInSkills: ["screen-code"] as const,
  };
  const options = makeCursorAgentOptions({
    modelSelection: { instanceId: config.providerInstanceId, model: "composer-2.5" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
    threadId,
    mcpSession: config,
    platform: "linux",
  });
  assert.deepEqual(options.mcpServers, cursorMcpServers(config));
  assert.include(
    buildRuntimeInstructions({
      harness: "Cursor",
      screenCode: McpProviderSession.carriesScreenCodeSkill(config),
      screenCodeCompact: true,
    }),
    "goat_screen_run",
  );
});
