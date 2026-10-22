import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as Setup from "../../../sshRemote/SshHostSetup.ts";
import * as Sessions from "../../../auth/SessionStore.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HubNodesError,
  ProviderInstanceId,
  SSH_PREFLIGHT_STEP_ORDER,
  type HubNode,
  type SavedConnection,
  type SshPreflightReport,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as Schema from "effect/Schema";

import * as Broker from "../../../connections/ConnectionCatalogBroker.ts";
import * as HubNodes from "../../../hubNodes/HubNodes.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ConnectionToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:connections");
const threadId = ThreadId.make("thread:connections");
const node: HubNode = {
  nodeId: environmentId,
  environmentId,
  label: "Remote",
  kind: "ssh",
  status: "online",
  lastSeenAt: null,
  addedBy: null,
  routes: [
    {
      routeId: "ssh:build-host",
      source: "registered",
      target: { kind: "ssh", alias: "build-host", hostname: null, username: null, port: null },
      status: "online",
      checkedAt: null,
      lastSeenAt: null,
      lastError: null,
    },
  ],
};
const saved: SavedConnection = {
  environmentId,
  label: "Remote",
  enabled: true,
  routes: [{ kind: "ssh", host: "build-host", hostname: "build-host", username: null, port: null }],
};
const outsideCaller = (
  access: "read-only" | "full-access" | "approval-required",
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:connections",
  thread: undefined,
  client: { sessionId: "client:connections", label: "Test agent", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  grantedScopes: ["orchestration:read", "orchestration:operate"],
  reauthorize: () => Effect.void,
});
const threadCaller: McpInvocationContext.McpInvocationScope = {
  ...outsideCaller("full-access"),
  client: undefined,
  grantedScopes: ["settings:write", "environment:maintain"],
  thread: {
    threadId,
    providerSessionId: "provider:connections",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const preflight: SshPreflightReport = {
  host: "build-host",
  destination: { alias: "build-host", hostname: "build.example", user: "deploy", port: 22 },
  ready: true,
  steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({
    id,
    state: "passed",
    summary: `${id} passed.`,
    ...(id === "host_key" ? { fingerprint: "SHA256:human-only" } : {}),
  })),
};
const noDesktop: Broker.ConnectionCatalogBroker["Service"]["invoke"] = () =>
  Effect.fail(new Broker.ConnectionCatalogHostUnavailable());
const testLayer = (
  caller: McpInvocationContext.McpInvocationScope = outsideCaller("full-access"),
  hub: Partial<HubNodes.HubNodes["Service"]> = {},
  broker: Partial<Broker.ConnectionCatalogBroker["Service"]> = {},
  setup: Partial<Setup.SshHostSetup["Service"]> = {},
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller)),
    Layer.provideMerge(
      SshDeviceAdd.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Sessions.SessionStore)({ cookieName: "test", legacyCookieName: undefined }),
            Layer.mock(Setup.SshHostSetup)({
              resolveDestination: (input) => Effect.succeed({ input, host: input.address }),
              preflight: () => Effect.succeed(preflight),
              ...setup,
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(Layer.mock(HubNodes.HubNodes)(hub)),
    Layer.provideMerge(
      Layer.mock(Broker.ConnectionCatalogBroker)({
        hasHost: Effect.succeed(false),
        invoke: noDesktop,
        ...broker,
      }),
    ),
  );

const call = <N extends keyof typeof ConnectionToolkit.tools>(
  name: N,
  input: Tool.Parameters<(typeof ConnectionToolkit.tools)[N]>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* ConnectionToolkit;
    const result = yield* toolkit.handle(name, input).pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)?.result;
  });

it.effect("goat serve alone lists nodes and notices without any desktop broker host", () =>
  call("goat_connection_list", {}).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toEqual({
          connections: [saved],
          nodes: [node, { ...node, environmentId: null, nodeId: "route:ssh:new" }],
          notices: [{ id: "desktop-import-locked", at: "2026-10-20T00:00:00.000Z" }],
        }),
      ),
    ),
    Effect.provide(
      testLayer(
        outsideCaller("read-only"),
        {
          snapshot: Effect.succeed({
            hubEnvironmentId: environmentId,
            nodes: [node, { ...node, environmentId: null, nodeId: "route:ssh:new" }],
            notices: [{ id: "desktop-import-locked", at: "2026-10-20T00:00:00.000Z" }],
          }),
        },
        {
          hasHost: Effect.die("List consulted desktop host"),
          invoke: () => Effect.die("List reached desktop"),
        },
      ),
    ),
  ),
);

it.effect("projects SSH, linked and cloud routes without credentials", () => {
  const routes: HubNode["routes"] = [
    {
      ...node.routes[0]!,
      target: { kind: "ssh", alias: "custom", hostname: "host.test", username: "jun", port: 2222 },
    },
    {
      ...node.routes[0]!,
      routeId: "linked:test",
      source: "linked-host",
      target: {
        kind: "linked",
        name: "test",
        baseUrl: "https://host.test",
        access: "read-only",
        expiresAt: "2026-10-21T00:00:00.000Z",
      },
    },
    {
      ...node.routes[0]!,
      routeId: "cloud:boat-bx_23456789",
      source: "cloud-machine",
      target: { kind: "cloud", alias: "boat-bx_23456789" },
    },
  ];
  return call("goat_connection_list", {}).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toMatchObject({
          connections: [
            {
              routes: [
                { kind: "ssh", host: "custom", hostname: "host.test", username: "jun", port: 2222 },
                { kind: "direct", httpBaseUrl: "https://host.test" },
                {
                  kind: "ssh",
                  host: "boat-bx_23456789",
                  hostname: "boat-bx_23456789",
                  username: null,
                  port: null,
                },
              ],
            },
          ],
        }),
      ),
    ),
    Effect.provide(
      testLayer(undefined, {
        snapshot: Effect.succeed({
          hubEnvironmentId: environmentId,
          nodes: [{ ...node, routes }],
          notices: [],
        }),
      }),
    ),
  );
});

const expectHubAdd =
  (created: boolean, attribution: Record<string, unknown>): HubNodes.HubNodes["Service"]["add"] =>
  (input, options) =>
    Effect.gen(function* () {
      expect(input).toMatchObject({
        kind: "ssh",
        alias: "build-host",
        hostname: null,
        username: null,
        port: null,
      });
      expect(options.requireIdentity).toBe(true);
      expect(options.addedBy).toMatchObject({ kind: "agent", ...attribution });
      expect(options.addedBy.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      yield* options.beforeSave;
      return { created, node };
    });

it.effect(
  "a thread add saves on the desktop with the ten minute timeout and registers on the hub",
  () =>
    Effect.gen(function* () {
      const result = yield* call("goat_connection_add_ssh", { host: "build-host", label: "Build" });
      expect(result).toMatchObject({
        outcome: "connected",
        created: true,
        connection: saved,
        hub: { saved: true, node },
        desktopCatalog: "saved",
      });
      expect(JSON.stringify(result)).not.toContain("fingerprint");
      expect(JSON.stringify(result)).not.toContain("SHA256:human-only");
    }).pipe(
      Effect.provide(
        testLayer(
          threadCaller,
          { add: expectHubAdd(true, { threadId }) },
          {
            invoke: (operation, timeoutMs) => {
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
            },
          },
        ),
      ),
    ),
);

it.effect("without a desktop, a full-access outside caller saves to the hub alone", () =>
  call("goat_connection_add_ssh", { host: "build-host", label: "Build" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toMatchObject({
          outcome: "connected",
          created: false,
          connection: saved,
          hub: { saved: true, node },
          desktopCatalog: "not_attached",
        }),
      ),
    ),
    Effect.provide(
      testLayer(undefined, {
        add: (input, options) => {
          expect(input).toMatchObject({ label: "Build" });
          expect(options.addedBy.threadId).toBeUndefined();
          return expectHubAdd(false, { client: "Test agent" })(input, options);
        },
      }),
    ),
  ),
);

it.effect("reports a hub failure after the desktop saved without failing the add", () =>
  call("goat_connection_add_ssh", { host: "build-host" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        expect(result).toMatchObject({
          outcome: "connected",
          connection: saved,
          hub: { saved: false, reason: "Could not reach build-host." },
          desktopCatalog: "saved",
        }),
      ),
    ),
    Effect.provide(
      testLayer(
        undefined,
        {
          add: () =>
            Effect.fail(
              new HubNodesError({
                reason: "host_unavailable",
                detail: "Could not reach build-host.",
              }),
            ),
        },
        { invoke: () => Effect.succeed({ type: "add_ssh", created: true, connection: saved }) },
      ),
    ),
  ),
);

it.effect.each([true, false])(
  "prepares an unidentified managed host without a desktop and retries the hub (prepare ok: %s)",
  (prepared) => {
    let attempts = 0;
    return call("goat_connection_add_ssh", { host: "build-host" }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(attempts).toBe(prepared ? 2 : 1);
          expect(result).toMatchObject(
            prepared
              ? { outcome: "connected", hub: { saved: true, node }, desktopCatalog: "not_attached" }
              : {
                  kind: "error",
                  saved: false,
                  reason: expect.stringContaining(
                    "GOAT has not run on build-host yet, so this hub cannot identify it.",
                  ),
                },
          );
        }),
      ),
      Effect.provide(
        testLayer(
          threadCaller,
          {
            add: (_input, options) =>
              ++attempts === 1
                ? Effect.fail(
                    new HubNodesError({ reason: "invalid_request", detail: "GOAT has not run" }),
                  )
                : options.beforeSave.pipe(Effect.as({ created: true, node })),
          },
          {},
          {
            resolveDestination: (input) =>
              Effect.succeed({ input, host: input.address, managed: true }),
            prepare: () =>
              Effect.succeed(
                prepared
                  ? {
                      kind: "ok",
                      status: {
                        host: "build-host",
                        state: "preparing",
                        runtimeVersion: null,
                        requestedVersion: "0.1.0",
                      },
                    }
                  : { kind: "error", code: "unsupported", message: "Install failed" },
              ),
          },
        ),
      ),
    );
  },
);

it.effect.each(["refused", "host_unavailable", "storage_failed"] as const)(
  "maps hub %s on a desktop-less add",
  (reason) =>
    call("goat_connection_add_ssh", { host: "build-host" }).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toMatchObject({
            code:
              reason === "storage_failed"
                ? "orchestration_error"
                : reason === "host_unavailable"
                  ? reason
                  : "invalid_request",
            message: "Hub failure",
          }),
        ),
      ),
      Effect.provide(
        testLayer(undefined, {
          add: () => Effect.fail(new HubNodesError({ reason, detail: "Hub failure" })),
        }),
      ),
    ),
);

it.effect("rechecks caller authority immediately before the hub saves", () => {
  const caller = outsideCaller("full-access");
  return call("goat_connection_add_ssh", { host: "build-host" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toMatchObject({ outcome: "capability_denied" })),
    ),
    Effect.provide(
      testLayer(caller, {
        add: (_input, options) =>
          Effect.gen(function* () {
            Object.assign(caller.client!, { access: "read-only" });
            yield* options.beforeSave;
            return yield* Effect.die("Revoked caller saved a node");
          }),
      }),
    ),
  );
});

it.effect("refuses read-only and approval-required clients on remove, and read-only on add", () =>
  Effect.forEach(["read-only", "approval-required"] as const, (access) =>
    Effect.gen(function* () {
      expect(yield* call("goat_connection_add_ssh", { host: "build-host" })).toMatchObject(
        access === "read-only"
          ? { code: "capability_denied" }
          : {
              outcome: "capability_denied",
              saved: false,
              reason: expect.stringContaining("settings:write"),
            },
      );
      expect(yield* call("goat_connection_remove", { environmentId })).toMatchObject({
        code: "capability_denied",
      });
    }).pipe(
      Effect.provide(
        testLayer(
          outsideCaller(access),
          {
            add: () => Effect.die("Denied caller reached the hub"),
            remove: () => Effect.die("Denied caller reached the hub"),
          },
          { invoke: () => Effect.die("Denied caller reached broker") },
        ),
      ),
    ),
  ),
);

it.effect("refuses an add without the orchestration capability", () =>
  call("goat_connection_add_ssh", { host: "build-host" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toMatchObject({ code: "capability_denied" })),
    ),
    Effect.provide(
      testLayer(
        { ...outsideCaller("full-access"), capabilities: new Set() },
        { add: () => Effect.die("Missing capability reached the hub") },
        { invoke: () => Effect.die("Missing capability reached broker") },
      ),
    ),
  ),
);

it.effect.each(["environmentId", "nodeId"] as const)(
  "removes using %s and forwards the identified environment",
  (key) =>
    call("goat_connection_remove", { [key]: environmentId }).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toEqual({ node, removed: saved, desktopCatalog: "saved" }),
        ),
      ),
      Effect.provide(
        testLayer(
          undefined,
          {
            remove: (input) => {
              expect(input).toEqual({ nodeId: environmentId });
              return Effect.succeed({ removed: node });
            },
          },
          {
            hasHost: Effect.succeed(true),
            invoke: (operation, timeoutMs) => {
              expect(operation).toEqual({ type: "remove", environmentId });
              expect(timeoutMs).toBe(30_000);
              return Effect.succeed({ type: "remove", removed: saved });
            },
          },
        ),
      ),
    ),
);

it.effect.each(["not_attached", "failed"] as const)(
  "keeps hub removal successful when desktop is %s",
  (desktop) =>
    call("goat_connection_remove", { nodeId: environmentId }).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toMatchObject({ node, removed: saved, desktopCatalog: desktop }),
        ),
      ),
      Effect.provide(
        testLayer(
          undefined,
          { remove: () => Effect.succeed({ removed: node }) },
          {
            hasHost: Effect.succeed(desktop === "failed"),
            invoke: () => Effect.fail(new Broker.ConnectionCatalogHostDetached()),
          },
        ),
      ),
    ),
);

it.effect("removes unidentified nodes without a legacy projection or desktop forward", () => {
  const unknown = { ...node, environmentId: null, nodeId: "route:ssh:build-host" };
  return call("goat_connection_remove", { nodeId: unknown.nodeId }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toEqual({ node: unknown, desktopCatalog: "not_attached" })),
    ),
    Effect.provide(
      testLayer(
        undefined,
        { remove: () => Effect.succeed({ removed: unknown }) },
        { hasHost: Effect.die("Unidentified remove reached desktop") },
      ),
    ),
  );
});

it.effect.each([
  "not_found",
  "invalid_request",
  "refused",
  "host_unavailable",
  "storage_failed",
] as const)("maps hub %s failures on list and remove", (reason) =>
  Effect.gen(function* () {
    const failure = Effect.fail(new HubNodesError({ reason, detail: "Hub failure" }));
    yield* Effect.gen(function* () {
      for (const result of [
        yield* call("goat_connection_list", {}),
        yield* call("goat_connection_remove", { nodeId: environmentId }),
      ]) {
        expect(result).toMatchObject({
          code:
            reason === "storage_failed"
              ? "orchestration_error"
              : reason === "host_unavailable"
                ? reason
                : "invalid_request",
          message: "Hub failure",
        });
      }
    }).pipe(Effect.provide(testLayer(undefined, { snapshot: failure, remove: () => failure })));
  }),
);

it("requires exactly one remove identifier", () => {
  const decode = Schema.decodeUnknownSync(
    ConnectionToolkit.tools.goat_connection_remove.parametersSchema,
  );
  expect(() => decode({})).toThrow();
  expect(() => decode({ nodeId: "node", environmentId })).toThrow();
  expect(decode({ nodeId: "node" })).toEqual({ nodeId: "node" });
  expect(decode({ environmentId })).toEqual({ environmentId });
});

it("rejects labels beyond the hub contract before saving", () => {
  const decodeAdd = Schema.decodeUnknownSync(
    ConnectionToolkit.tools.goat_connection_add_ssh.parametersSchema,
  );
  expect(() => decodeAdd({ host: "build-host", label: "x".repeat(121) })).toThrow();
  expect(decodeAdd({ host: "build-host", label: "x".repeat(120) })).toHaveProperty(
    "host",
    "build-host",
  );
});

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
        Layer.provide(Layer.mock(HubNodes.HubNodes)({})),
        Layer.provide(Layer.mock(SshDeviceAdd.SshDeviceAdd)({})),
        Layer.provide(
          Layer.mock(Broker.ConnectionCatalogBroker)({
            invoke: () => Effect.die("Unknown arguments reached broker"),
          }),
        ),
      ),
    ),
  ),
);
