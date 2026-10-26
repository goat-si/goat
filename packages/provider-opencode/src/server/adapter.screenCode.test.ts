import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

it("puts goat_screen_run in OpenCode's guide when its GOAT MCP session carries screen code", () => {
  const config = {
    environmentId: EnvironmentId.make("env-screen"),
    threadId: ThreadId.make("thread-screen"),
    providerSessionId: "session-screen",
    providerInstanceId: ProviderInstanceId.make("opencode"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer test",
    browserToolsAvailable: true,
    builtInSkills: ["screen-code"] as const,
  };
  assert.include(
    buildRuntimeInstructions({
      harness: "OpenCode",
      screenCode: McpProviderSession.carriesScreenCodeSkill(config),
    }),
    "goat_screen_run",
  );
});
