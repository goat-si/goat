import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as HubParity from "../../../hub/HubParity.ts";
import * as OpenCodexSync from "../../../hub/OpenCodexSync.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { HostStatusToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:host-status");
const threadId = ThreadId.make("thread:host-status");
const outsideCaller = (
  access: "read-only" | "full-access",
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:host-status",
  thread: undefined,
  client: { sessionId: "client:host-status", label: "Test agent", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const testLayer = (
  caller: McpInvocationContext.McpInvocationScope,
  read: HostStatusMcpService.HostStatusMcpServiceShape["read"],
  verify: HubParity.HubParity["Service"]["verify"] = () => Effect.die("Unexpected verify"),
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller)),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(Layer.mock(HubParity.HubParity)({ verify })),
    Layer.provideMerge(Layer.mock(HostStatusMcpService.HostStatusMcpService)({ read })),
  );

it.effect("lets a read-only client read this machine without reaching SSH", () =>
  Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_host_status", { local: true })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({ hosts: [] });
  }).pipe(
    Effect.provide(
      testLayer(outsideCaller("read-only"), (_scope, input) => {
        expect(input).toEqual({ local: true });
        return Effect.succeed({ hosts: [] });
      }),
    ),
  ),
);

it.effect("refuses a read-only client's fan-out before host status runs", () =>
  Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_host_status", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      testLayer(outsideCaller("read-only"), () => Effect.die("Read-only fan-out reached status")),
    ),
  ),
);

it.effect("refuses a local read without the orchestration capability", () =>
  Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_host_status", { local: true })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      testLayer({ ...outsideCaller("read-only"), capabilities: new Set() }, () =>
        Effect.die("Missing capability reached status"),
      ),
    ),
  ),
);

it.effect("lets a live thread caller read one host", () => {
  const seen: Array<string | undefined> = [];
  return Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_host_status", { host: "box" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(seen).toEqual(["box"]);
    expect(result.at(-1)?.result).toEqual({
      hosts: [{ host: "box", reachability: "ok" }],
    });
  }).pipe(
    Effect.provide(
      testLayer(
        {
          ...outsideCaller("full-access"),
          thread: {
            threadId,
            providerSessionId: "provider:host-status",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
        },
        (_scope, input) => {
          seen.push(input.host);
          return Effect.succeed({ hosts: [{ host: "box", reachability: "ok" as const }] });
        },
      ),
    ),
  );
});

it.effect("parity verification refuses a read-only client before reaching SSH", () =>
  Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_hub_device_verify", { deviceAlias: "mac-studio" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(testLayer(outsideCaller("read-only"), () => Effect.die("Unexpected status"))),
  ),
);

it.effect("a full-access caller receives the service verdict without repair", () =>
  Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_hub_device_verify", { deviceAlias: "mac-studio" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({
      deviceAlias: "mac-studio",
      parity: { verdict: "unproven", checkedAt: 0, failingCheckIds: [], checks: [] },
    });
  }).pipe(
    Effect.provide(
      testLayer(
        outsideCaller("full-access"),
        () => Effect.die("Unexpected status"),
        (alias, scope) => {
          expect(alias).toBe("mac-studio");
          expect(scope.requestNamespace).toBe("client:host-status");
          return Effect.succeed({
            verdict: "unproven",
            checkedAt: 0,
            failingCheckIds: [],
            checks: [],
          });
        },
      ),
    ),
  ),
);

/** A thread whose profile grants hub.manage everywhere but threads.remote only for mac-studio. */
const syncDependencies = Layer.mergeAll(
  Layer.mock(OpenCodexSync.OpenCodexSync)({
    plan: (_scope, permits) =>
      Effect.gen(function* () {
        const members = [];
        for (const alias of ["mac-studio", "lidge-ts"])
          members.push({
            alias,
            state: (yield* permits!(alias)) ? ("ready" as const) : ("skipped" as const),
            restartCodex: true,
          });
        return { trigger: "plan" as const, checkedAt: 0, members };
      }),
    run: () => Effect.die("A dry run never syncs."),
  }),
  Layer.mock(Profiles.PermissionProfiles)({
    resolve: () =>
      Effect.succeed({
        enabled: true,
        runtimeMode: "full-access" as const,
        profile: {
          id: "fixture",
          runtimeModeCeiling: "full-access" as const,
          capabilities: ["hub.manage", "threads.remote"] as const,
          hosts: ["mac-studio"],
          maxLanes: 4,
        },
      }),
  }),
);

it.effect("plans an OpenCodex sync only for Children the thread's profile may reach", () =>
  Effect.gen(function* () {
    const toolkit = yield* HostStatusToolkit;
    const result = yield* toolkit
      .handle("goat_hub_opencodex_sync", { dryRun: true })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({
      trigger: "plan",
      members: [
        { alias: "mac-studio", state: "ready" },
        { alias: "lidge-ts", state: "skipped" },
      ],
    });
  }).pipe(
    Effect.provide(
      testLayer(
        {
          ...outsideCaller("full-access"),
          thread: {
            threadId,
            providerSessionId: "provider:host-status",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
        },
        () => Effect.die("Unexpected status"),
      ).pipe(Layer.provideMerge(syncDependencies)),
    ),
  ),
);
