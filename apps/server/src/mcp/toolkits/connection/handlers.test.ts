import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type SavedConnection, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as Broker from "../../../connections/ConnectionCatalogBroker.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ConnectionToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:connections");
const threadId = ThreadId.make("thread:connections");
const saved: SavedConnection = { environmentId, label: "Remote", enabled: true, routes: [] };
const outsideCaller = (
  access: "read-only" | "full-access" | "approval-required",
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:connections",
  thread: undefined,
  client: { sessionId: "client:connections", label: "Test agent", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const threadCaller: McpInvocationContext.McpInvocationScope = {
  ...outsideCaller("full-access"),
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "provider:connections",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const testLayer = (
  caller: McpInvocationContext.McpInvocationScope,
  invoke: Broker.ConnectionCatalogBroker["Service"]["invoke"],
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller)),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(Layer.mock(Broker.ConnectionCatalogBroker)({ invoke })),
  );

it.effect("read-only clients can list saved connections", () =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit
      .handle("goat_connection_list", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({ connections: [saved] });
  }).pipe(
    Effect.provide(
      testLayer(outsideCaller("read-only"), (operation, timeoutMs) => {
        expect(operation).toEqual({ type: "list" });
        expect(timeoutMs).toBe(30_000);
        return Effect.succeed({ type: "list", connections: [saved] });
      }),
    ),
  ),
);

it.effect(
  "refuses read-only and approval-required clients on add and remove before broker invocation",
  () =>
    Effect.forEach(["read-only", "approval-required"] as const, (access) =>
      Effect.gen(function* () {
        const toolkit = yield* ConnectionToolkit;
        const add = yield* toolkit
          .handle("goat_connection_add_ssh", { host: "build-host" })
          .pipe(Stream.unwrap, Stream.runCollect);
        const remove = yield* toolkit
          .handle("goat_connection_remove", { environmentId })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(add.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        expect(remove.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }).pipe(
        Effect.provide(
          testLayer(outsideCaller(access), () => Effect.die("Denied caller reached broker")),
        ),
      ),
    ),
);

it.effect("attributes a thread add and supplies the ten minute SSH timeout", () =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit
      .handle("goat_connection_add_ssh", { host: "build-host", label: "Build" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({ created: true, connection: saved });
  }).pipe(
    Effect.provide(
      testLayer(threadCaller, (operation, timeoutMs) => {
        expect(operation).toMatchObject({
          type: "add_ssh",
          host: "build-host",
          label: "Build",
          addedBy: { kind: "agent", threadId },
        });
        if (operation.type === "add_ssh") {
          expect(operation.addedBy.client).toBeUndefined();
          expect(operation.addedBy.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }
        expect(timeoutMs).toBe(600_000);
        return Effect.succeed({ type: "add_ssh", created: true, connection: saved });
      }),
    ),
  ),
);

it.effect("attributes a full-access outside add and returns idempotent created:false", () =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit
      .handle("goat_connection_add_ssh", { host: "build-host" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({ created: false, connection: saved });
  }).pipe(
    Effect.provide(
      testLayer(outsideCaller("full-access"), (operation) => {
        expect(operation).toMatchObject({ addedBy: { kind: "agent", client: "Test agent" } });
        if (operation.type === "add_ssh") expect(operation.addedBy.threadId).toBeUndefined();
        return Effect.succeed({ type: "add_ssh", created: false, connection: saved });
      }),
    ),
  ),
);

it.effect("refuses an add without the orchestration capability", () =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit
      .handle("goat_connection_add_ssh", { host: "build-host" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      testLayer({ ...outsideCaller("full-access"), capabilities: new Set() }, () =>
        Effect.die("Missing capability reached broker"),
      ),
    ),
  ),
);

it.effect("maps no desktop host to actionable host_unavailable", () =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit
      .handle("goat_connection_list", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({
      code: "host_unavailable",
      message:
        "No GOAT desktop app is serving saved connections for this environment. Saved connections belong to the desktop app that runs this environment as its main local environment: open it on this machine, or add the host in Settings → Connections → SSH. Web-only, mobile and desktop WSL-backend environments cannot save SSH connections through agents.",
    });
  }).pipe(
    Effect.provide(
      testLayer(outsideCaller("read-only"), () =>
        Effect.fail(new Broker.ConnectionCatalogHostUnavailable()),
      ),
    ),
  ),
);

it.effect("maps renderer refusal, failure and mismatched operation responses", () =>
  Effect.forEach(
    [
      [
        { type: "failure", reason: "refused", message: "Local environment cannot be removed" },
        "invalid_request",
      ],
      [
        { type: "failure", reason: "connection_failed", message: "Key login failed" },
        "host_unavailable",
      ],
      [{ type: "list", connections: [] }, "invalid_request"],
    ] as const,
    ([response, code]) =>
      Effect.gen(function* () {
        const toolkit = yield* ConnectionToolkit;
        const result = yield* toolkit
          .handle("goat_connection_remove", { environmentId })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.result).toMatchObject({ code });
      }).pipe(
        Effect.provide(testLayer(outsideCaller("full-access"), () => Effect.succeed(response))),
      ),
  ),
);

it.effect("removes with a thirty second timeout", () =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit
      .handle("goat_connection_remove", { environmentId })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({ removed: saved });
  }).pipe(
    Effect.provide(
      testLayer(outsideCaller("full-access"), (operation, timeoutMs) => {
        expect(operation).toEqual({ type: "remove", environmentId });
        expect(timeoutMs).toBe(30_000);
        return Effect.succeed({ type: "remove", removed: saved });
      }),
    ),
  ),
);

it.effect("production registration refuses undeclared arguments before invoking the broker", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "goat_connection_list", arguments: { host: "wrong-machine" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          outsideCaller("read-only"),
        ),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "connections", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "connections", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([
      { type: "text", text: expect.stringContaining("invalid_request") },
    ]);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerConnectionToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(liveThreadsLayer),
        Layer.provide(
          Layer.mock(Broker.ConnectionCatalogBroker)({
            invoke: () => Effect.die("Unknown arguments reached broker"),
          }),
        ),
      ),
    ),
  ),
);
