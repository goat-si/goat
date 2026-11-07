import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ServerSettingsError, type GoatMcpServerLaunch } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { goatMcpServersFor } from "./goatSessionConfig.ts";

const settingsLayer = ServerSettings.layerTest({
  mcpServers: {
    local: { enabled: true, transport: "stdio", command: "example", args: ["serve"], env: {} },
    remote: { enabled: true, transport: "http", url: "https://mcp.example.test/mcp", headers: {} },
    off: { enabled: false, transport: "stdio", command: "never", args: [], env: {} },
  },
}).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-session-" })),
  Layer.provideMerge(NodeServices.layer),
);

const started: GoatMcpServerLaunch = {
  providerName: "started_goat",
  transport: "stdio",
  command: "started",
  args: [],
  env: {},
};

it.effect("a new credential reads enabled servers the driver supports", () =>
  Effect.gen(function* () {
    const settings = Option.some(yield* ServerSettings.ServerSettingsService);
    const codex = yield* goatMcpServersFor(undefined, undefined, settings, "codex");
    assert.deepEqual(
      codex.map((server) => server.providerName),
      ["local_goat", "remote_goat"],
    );
    const grok = yield* goatMcpServersFor(undefined, undefined, settings, "grok");
    assert.deepEqual(
      grok.map((server) => server.providerName),
      ["local_goat"],
    );
    assert.deepEqual(yield* goatMcpServersFor(undefined, undefined, settings, "opencode"), []);
  }).pipe(Effect.provide(settingsLayer)),
);

it.effect("a renewed credential keeps the list its provider process started with", () =>
  Effect.gen(function* () {
    const settings = Option.some(yield* ServerSettings.ServerSettingsService);
    const kept = yield* goatMcpServersFor(
      { goatMcpServers: [started] },
      { providerSessionId: "renewed" },
      settings,
      "codex",
    );
    assert.deepEqual(kept, [started]);
  }).pipe(Effect.provide(settingsLayer)),
);

it.effect("unreadable settings start the session without GOAT servers", () =>
  Effect.gen(function* () {
    const failing = Option.some({
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "/missing/settings.json", operation: "read-file" }),
      ),
    });
    assert.deepEqual(yield* goatMcpServersFor(undefined, undefined, failing, "codex"), []);
  }),
);

it.effect("no settings service or unknown driver means no GOAT servers", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* goatMcpServersFor(undefined, undefined, Option.none(), "codex"), []);
    const settings = Option.some(yield* ServerSettings.ServerSettingsService);
    assert.deepEqual(yield* goatMcpServersFor(undefined, undefined, settings, undefined), []);
  }).pipe(Effect.provide(settingsLayer)),
);
