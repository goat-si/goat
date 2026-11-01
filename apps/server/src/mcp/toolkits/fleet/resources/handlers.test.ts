import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Fallback from "../../../../fleet/resources/Fallback.ts";
import * as Placement from "../../../../fleet/resources/Placement.ts";
import * as ThreadManagement from "../../../../orchestration-v2/ThreadManagementService.ts";
import * as HostStatusMcpService from "../../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";
import * as McpToolAccess from "../../../McpToolAccess.ts";
import { liveThreadShell } from "../../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { FleetResourcesToolkit } from "./tools.ts";

const caller = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:fleet"),
  requestNamespace: "thread:fleet",
  thread: {
    threadId: ThreadId.make("thread:fleet-caller"),
    providerSessionId: "provider:fleet",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const empty = { chains: {}, defaultFallbackChain: null };
const status = {
  controllerEnabled: false,
  maxRunningThreads: null,
  threads: 0,
  hosts: [],
  cooldowns: [],
  decisions: [],
};

const testLayer = (
  runtimeMode: "full-access" | "approval-required",
  chains: Partial<Fallback.FallbackChainsShape>,
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller())),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId, { runtimeMode })),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(HostStatusMcpService.HostStatusMcpService)({
        read: (_scope, input) => {
          expect(input).toEqual({ local: true });
          return Effect.succeed({ hosts: [] });
        },
      }),
    ),
    Layer.provideMerge(Layer.mock(Placement.Placement)({ statusOf: () => Effect.succeed(status) })),
    Layer.provideMerge(Layer.mock(Fallback.FallbackChains)(chains)),
  );

const call = <Name extends keyof typeof FleetResourcesToolkit.tools>(name: Name, input: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* FleetResourcesToolkit;
    const result = yield* toolkit
      .handle(name, input as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)?.result;
  });

it.effect("refuses goat_fallback_chain_set below full access before touching settings", () =>
  call("goat_fallback_chain_set", { id: "claude", chain: null }).pipe(
    Effect.map((result) => expect(result).toMatchObject({ code: "capability_denied" })),
    Effect.provide(testLayer("approval-required", { set: () => Effect.die("set ran") })),
  ),
);

it.effect("saves a chain for a full-access caller with a commit-time recheck", () => {
  const seen: Array<{ id: string; recheck: boolean }> = [];
  return call("goat_fallback_chain_set", {
    id: "claude",
    chain: { steps: [{ instanceId: "codex", model: "gpt-6.1-sol" }] },
  }).pipe(
    Effect.map((result) => {
      expect(seen).toEqual([{ id: "claude", recheck: true }]);
      expect(result).toEqual({ ...empty, warnings: [] });
    }),
    Effect.provide(
      testLayer("full-access", {
        set: (input, authorizeAtCommit) =>
          (authorizeAtCommit ?? Effect.void).pipe(
            Effect.orDie,
            Effect.andThen(
              Effect.sync(() =>
                seen.push({ id: input.id, recheck: authorizeAtCommit !== undefined }),
              ),
            ),
            Effect.as({ ...empty, warnings: [] }),
          ),
      }),
    ),
  );
});

it.effect("reports an unknown chain id from goat_fallback_chain_get", () =>
  call("goat_fallback_chain_get", { id: "missing" }).pipe(
    Effect.map((result) =>
      expect(result).toMatchObject({
        code: "invalid_request",
        message: "No fallback chain named missing is configured.",
      }),
    ),
    Effect.provide(testLayer("approval-required", { get: Effect.succeed(empty) })),
  ),
);

it.effect("reads local scheduler status without fanning out", () =>
  call("goat_scheduler_status", { local: true }).pipe(
    Effect.map((result) => expect(result).toEqual(status)),
    Effect.provide(testLayer("approval-required", {})),
  ),
);
