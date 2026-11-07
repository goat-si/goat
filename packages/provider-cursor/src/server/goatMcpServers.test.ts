import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { cursorMcpServers } from "./agentOptions.ts";

it("includes GOAT global stdio and HTTP servers in the Cursor send map", () => {
  const servers = cursorMcpServers({
    environmentId: EnvironmentId.make("fixture"),
    threadId: ThreadId.make("fixture"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("cursor"),
    endpoint: "http://localhost/mcp",
    authorizationHeader: "fixture",
    browserToolsAvailable: false,
    goatMcpServers: [
      {
        providerName: "local_goat",
        transport: "stdio",
        command: "tool",
        args: ["run"],
        env: { KEY: "value" },
      },
      {
        providerName: "remote_goat",
        transport: "http",
        url: "https://example.test",
        headers: { Authorization: "fixture" },
      },
    ],
  });
  expect(servers?.local_goat).toEqual({
    type: "stdio",
    command: "tool",
    args: ["run"],
    env: { KEY: "value" },
  });
  expect(servers?.remote_goat).toEqual({
    type: "http",
    url: "https://example.test",
    headers: { Authorization: "fixture" },
  });
});
