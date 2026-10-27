import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { codexHomeRouteArgv } from "../provider/CodexHomeRouteConfig.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as HomeRoute from "../provider/OpenCodexRoute.ts";
import * as ReadyProbe from "./CodexReadyProbe.ts";

// The real probe against a scripted app-server peer at the stdio boundary. The peer derives its
// effective config from its -c overrides, as Codex layers them, and logs each spawn and request.
// Durable replay (proof reuse, no repeated unrecorded request) is in OpenCodexChildReady.test.ts.
const PEER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.PEER_MODE || "ok";
const log = (line) => fs.appendFileSync(process.env.PEER_LOG, line + "\n");
const config = {};
const servers = JSON.parse(process.env.PEER_MCP || "{}");
if (Object.keys(servers).length > 0) config.mcp_servers = servers;
const parseValue = (raw) => {
  if (!raw.startsWith("{")) return JSON.parse(raw);
  const table = {};
  for (const pair of raw.slice(1, -1).split(",")) {
    const at = pair.indexOf("=");
    table[pair.slice(0, at).trim()] = JSON.parse(pair.slice(at + 1));
  }
  return table;
};
const args = process.argv.slice(2);
log("spawn " + args.join(" "));
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "-c") continue;
  const arg = args[++index];
  const at = arg.indexOf("=");
  const key = arg.slice(0, at);
  if (mode === "ignore-mcp-overrides" && key.startsWith("mcp_servers.")) continue;
  const parts = key.split(".");
  let node = config;
  for (const part of parts.slice(0, -1)) node = node[part] = node[part] || {};
  node[parts[parts.length - 1]] = parseValue(arg.slice(at + 1));
}
const write = (message, then) => process.stdout.write(JSON.stringify(message) + "\n", then);
const turn = (status, items) => ({
  id: "turn-1",
  items,
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1,
  completedAt: status === "completed" ? 2 : null,
  durationMs: null,
});
const completed = () =>
  write({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: turn("completed", [{ type: "agentMessage", id: "m1", text: "READY" }]),
    },
  });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return log("answered " + message.id);
  log(message.method);
  const { id, method } = message;
  if (id === undefined) return;
  const reply = (result, then) => write({ id, result }, then);
  if (method === "initialize")
    return reply({
      userAgent: "codex/0.156.0",
      codexHome: process.env.CODEX_HOME,
      platformFamily: "unix",
      platformOs: "linux",
    });
  if (method === "config/read") return reply({ config, origins: {} });
  if (method === "model/list")
    return reply({
      data: [
        {
          id: "home-model",
          model: "home-model",
          displayName: "Home model",
          description: "",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
        },
      ],
      nextCursor: null,
    });
  if (method === "thread/start") {
    const provider = mode === "other-provider" ? "openai" : "opencodex";
    return reply({
      thread: {
        id: "thread-1",
        sessionId: "thread-1",
        forkedFromId: null,
        preview: "",
        ephemeral: mode !== "persistent-thread",
        modelProvider: provider,
        createdAt: 1,
        updatedAt: 1,
        status: { type: "idle" },
        path: "/tmp/thread-1.jsonl",
        cwd: message.params.cwd,
        cliVersion: "0.156.0",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: "home-model",
      modelProvider: provider,
      serviceTier: null,
      cwd: message.params.cwd,
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      reasoningEffort: "low",
    });
  }
  if (method === "turn/start") {
    if (mode === "exit-before-ack") return process.exit(1);
    if (mode === "complete-before-ack") {
      completed();
      return reply({ turn: turn("inProgress", []) });
    }
    if (mode === "exit-after-ack") return reply({ turn: turn("inProgress", []) }, () => process.exit(1));
    reply({ turn: turn("inProgress", []) });
    if (mode === "tool-request")
      return write({
        id: 900,
        method: "item/tool/requestUserInput",
        params: {
          itemId: "tool-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "go",
              header: "Go",
              question: "Run the tool?",
              options: [{ label: "yes", description: "Run it" }],
            },
          ],
        },
      });
    if (mode === "unknown-request")
      return write({ id: 901, method: "goat/test/toolCall", params: {} });
    if (mode === "tool-item")
      return write({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAtMs: 1,
          item: { type: "webSearch", id: "search-1", query: "anything" },
        },
      });
    return completed();
  }
  write({ id, error: { code: -32601, message: "unsupported" } });
});
`;

const decodeSettings = Schema.decodeSync(CodexSettings);
const settings = decodeSettings({
  setupMode: "managed",
  modelRoute: "opencodex",
  opencodexAuth: "none",
});

const fixture = Effect.fn("CodexReadyProbe.test.fixture")(function* (
  options: {
    readonly mode?: string;
    readonly mcpServers?: Readonly<Record<string, unknown>>;
    /** The installed managed executable differs from the one the runtime acquired. */
    readonly replacedExecutable?: boolean;
    readonly routeUnavailable?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ready-probe-test-" });
  const binary = path.join(dir, "codex");
  yield* fs.writeFileString(binary, PEER);
  yield* fs.chmod(binary, 0o755);
  const log = path.join(dir, "peer.log");
  const catalog = path.join(dir, "opencodex-catalog.json");
  let leases = 0;
  const executable = (executablePath: string) => ({
    executablePath,
    source: "managed" as const,
    version: "0.156.0",
    managedVersionDirectory: dir,
  });
  const context = yield* Layer.build(
    ReadyProbe.layer.pipe(
      Layer.provide(
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: dir,
          acquire: () => Effect.succeed(executable(binary)),
          resolve: () =>
            Effect.succeed(
              executable(options.replacedExecutable ? path.join(dir, "other-codex") : binary),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(HomeRoute.OpenCodexRoute)({
          launchArgs: (input) =>
            Effect.succeed(
              codexHomeRouteArgv(
                input.settings,
                HomeRoute.normalizeOpenCodexBaseUrl(input.settings.opencodexBaseUrl),
                catalog,
              ),
            ),
          // Each native launch leases the verified route first.
          requireAvailable: () =>
            options.routeUnavailable
              ? Effect.fail(new HomeRoute.OpenCodexRouteUnavailable({ detail: "Reconnecting" }))
              : Effect.sync(() => void leases++),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-ready-probe-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const probe = Context.get(context, ReadyProbe.CodexReadyProbe).probe({
    instanceId: ProviderInstanceId.make("goat_ocx_0123456789abcdef01234567"),
    settings,
    environment: {
      PEER_LOG: log,
      PEER_MODE: options.mode ?? "ok",
      PEER_MCP: JSON.stringify(options.mcpServers ?? {}),
    },
  });
  const peerLog = fs.readFileString(log).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line.length > 0)),
    Effect.orElseSucceed((): Array<string> => []),
  );
  return { probe, peerLog, leases: () => leases };
});

const failureOf = <A, R>(effect: Effect.Effect<A, ReadyProbe.CodexReadyProbeError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

it.live("requires a completed matching native turn through the leased Child route", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.probe).toMatchObject({ model: "home-model", executableVersion: "0.156.0" });
    const log = yield* f.peerLog;
    expect(log.filter((line) => line.startsWith("spawn "))).toHaveLength(2);
    expect(log).toContain("thread/start");
    expect(log).toContain("turn/start");
    expect(f.leases()).toBe(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("disables every configured MCP server before any thread starts", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      mcpServers: { docs: { command: "docs-mcp" }, search: { url: "http://127.0.0.1:9/mcp" } },
    });
    yield* f.probe;
    const log = yield* f.peerLog;
    const threaded = log.slice(0, log.indexOf("thread/start"));
    const launch = threaded.findLast((line) => line.startsWith("spawn "));
    expect(launch).toContain("mcp_servers.docs.enabled=false");
    expect(launch).toContain("mcp_servers.search.enabled=false");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses before thread/start when the effective config still offers a tool", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      mode: "ignore-mcp-overrides",
      mcpServers: { docs: { command: "docs-mcp" } },
    });
    expect(yield* failureOf(f.probe)).toBe("probe_unsupported");
    expect(yield* f.peerLog).not.toContain("thread/start");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("accepts completion received before the turn start acknowledgement", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ mode: "complete-before-ack" });
    expect(yield* f.probe).toMatchObject({ model: "home-model" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["tool-request", "unknown-request", "tool-item"])(
  "refuses a tool during the turn without proof: %s",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture({ mode });
      expect(yield* failureOf(f.probe)).toBe("probe_unsupported");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["persistent-thread", "other-provider"])(
  "refuses a native thread that is not ephemeral on the Home route: %s",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture({ mode });
      expect(yield* failureOf(f.probe)).toBe("route_unverified");
      expect(yield* f.peerLog).not.toContain("turn/start");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["exit-before-ack", "exit-after-ack"])(
  "fails without proof when the app-server terminates mid-request: %s",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture({ mode });
      expect(yield* failureOf(f.probe)).toBe("probe_failed");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("never launches Codex when the Home route cannot be leased", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ routeUnavailable: true });
    expect(yield* failureOf(f.probe)).toBe("route_unverified");
    expect(yield* f.peerLog).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("never launches Codex when the hydrated runtime and installed executable differ", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ replacedExecutable: true });
    expect(yield* failureOf(f.probe)).toBe("route_unverified");
    expect(yield* f.peerLog).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
