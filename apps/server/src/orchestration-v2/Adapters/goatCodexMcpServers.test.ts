import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeCodexMcpConfigReader } from "./goatCodexMcpServers.ts";

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
