import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { availability } from "../../mcp/toolAvailability.ts";
import { codexThreadRuntimeParams } from "./CodexAdapterV2.ts";
import { claudeMcpQueryOverrides } from "./ClaudeAdapterV2.ts";

const session = {
  environmentId: EnvironmentId.make("environment-screen-attach"),
  threadId: ThreadId.make("thread-screen-attach"),
  providerSessionId: "session-screen-attach",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer test-screen",
  browserToolsAvailable: true,
  builtInSkills: ["screen-code"] as const,
};

const screenAvailability = (attached: boolean) =>
  availability(
    agentSurfaceRegistry["surface.screen_run"],
    {
      environmentId: session.environmentId,
      requestNamespace: `provider:${session.threadId}`,
      thread: {
        threadId: session.threadId,
        providerSessionId: session.providerSessionId,
        providerInstanceId: session.providerInstanceId,
      },
      client: undefined,
      capabilities: new Set(attached ? ["screen"] : []),
      issuedAt: 0,
    },
    true,
  );

it("Codex passes the authenticated GOAT endpoint and refuses screen without an attached surface", () => {
  const params = codexThreadRuntimeParams({ mcpSession: session });
  assert.include(JSON.stringify(params.config["mcp_servers.goat"]), session.endpoint);
  assert.include(JSON.stringify(params.config["mcp_servers.goat"]), session.authorizationHeader);
  assert.deepEqual(screenAvailability(true), { now: true });
  assert.isFalse(screenAvailability(false).now);
});

it("Claude passes the authenticated GOAT endpoint and refuses screen without an attached surface", () => {
  const options = claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: false });
  assert.include(JSON.stringify(options.mcpServers?.goat), session.endpoint);
  assert.include(JSON.stringify(options.mcpServers?.goat), session.authorizationHeader);
  assert.deepEqual(screenAvailability(true), { now: true });
  assert.isFalse(screenAvailability(false).now);
});
