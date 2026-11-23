import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import {
  makeCodexMcpConfigReader,
  codexStdioThreadEnvironment,
  codexGoatServerConfig,
} from "./goatCodexMcpServers.ts";

const session = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("fixture"),
  providerSessionId: "fixture",
  providerInstanceId: ProviderInstanceId.make("fixture"),
  endpoint: "http://localhost/mcp",
  authorizationHeader: "fixture",
  browserToolsAvailable: false,
  goatMcpServers: [
    { providerName: "one_goat", transport: "stdio", command: "one", args: [], env: {} },
    { providerName: "two_goat", transport: "http", url: "https://example.test", headers: {} },
  ],
} as const;

it("sets the thread id for stdio servers without changing HTTP or dotted server names", () => {
  expect(
    codexStdioThreadEnvironment(
      {
        local: { command: "node" },
        remote: { url: "https://example.test" },
        "dotted.name": { command: "node" },
      },
      ThreadId.make("thread-1"),
    ),
  ).toEqual({
    "mcp_servers.local.env.GOAT_THREAD_ID": "thread-1",
    "mcp_servers.local.env.T3CODE_THREAD_ID": "thread-1",
  });
});

it("passes the thread id to GOAT configured stdio servers without changing HTTP servers", () => {
  const configured = codexGoatServerConfig(session.goatMcpServers, session.threadId);
  expect(configured["mcp_servers.one_goat"]).toEqual({
    command: "one",
    args: [],
    env: { GOAT_THREAD_ID: "fixture", T3CODE_THREAD_ID: "fixture" },
  });
  expect(configured["mcp_servers.two_goat"]).toEqual({
    url: "https://example.test",
    http_headers: {},
  });
});

it.effect("keeps the user's Codex server and injects nonconflicting GOAT servers", () =>
  Effect.gen(function* () {
    const reader = makeCodexMcpConfigReader(() =>
      Effect.succeed({ config: { mcp_servers: { one_goat: {} } } }),
    );
    const filtered = yield* reader.filterGoatServers(session, "/workspace");
    expect(filtered?.goatMcpServers?.map((server) => server.providerName)).toEqual(["two_goat"]);
  }),
);

it.effect("skips every GOAT server when Codex config cannot be read", () =>
  Effect.gen(function* () {
    const reader = makeCodexMcpConfigReader(() => Effect.fail("unavailable"));
    const filtered = yield* reader.filterGoatServers(session, "/workspace");
    expect(filtered?.goatMcpServers).toEqual([]);
  }),
);
