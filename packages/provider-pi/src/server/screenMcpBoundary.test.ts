import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import {
  GOAT_MCP_BEARER_ENV,
  GOAT_MCP_URL_ENV,
  GOAT_SCREEN_CODE_SKILL_ENV,
} from "./mcpExtensionSource.ts";
import { buildPiRpcLaunch } from "./mcpInjection.ts";

it("Pi's extension gets GOAT MCP credentials while a detached screen guide stays off", () => {
  const session = {
    environmentId: EnvironmentId.make("pi-screen-mcp"),
    threadId: ThreadId.make("pi-screen-mcp"),
    providerSessionId: "pi-screen-mcp",
    providerInstanceId: ProviderInstanceId.make("pi"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer pi-screen",
    browserToolsAvailable: true,
  };
  const launch = buildPiRpcLaunch({
    launchArgs: [],
    environment: {},
    mcpSession: session,
    extensionPath: "/tmp/pi-goat-mcp-extension.ts",
  });
  assert.equal(launch.env[GOAT_MCP_URL_ENV], session.endpoint);
  assert.equal(launch.env[GOAT_MCP_BEARER_ENV], "pi-screen");
  assert.equal(launch.env[GOAT_SCREEN_CODE_SKILL_ENV], "off");
});
