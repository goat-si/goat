import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import { makeCursorAgentOptions } from "./adapter.ts";

it("Cursor sends GOAT MCP credentials and omits the server without a session", () => {
  const threadId = ThreadId.make("cursor-screen-mcp");
  const session = {
    environmentId: EnvironmentId.make("cursor-screen-mcp"),
    threadId,
    providerSessionId: "cursor-screen-mcp",
    providerInstanceId: ProviderInstanceId.make("cursor"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer cursor-screen",
    browserToolsAvailable: true,
  };
  const options = makeCursorAgentOptions({
    modelSelection: { instanceId: session.providerInstanceId, model: "composer-2.5" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
    threadId,
    mcpSession: session,
    platform: "linux",
  });
  assert.include(JSON.stringify(options.mcpServers?.goat), session.endpoint);
  assert.include(JSON.stringify(options.mcpServers?.goat), session.authorizationHeader);
  assert.isUndefined(
    makeCursorAgentOptions({
      modelSelection: { instanceId: session.providerInstanceId, model: "composer-2.5" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
      threadId,
      mcpSession: undefined,
      platform: "linux",
    }).mcpServers,
  );
});
