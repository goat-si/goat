import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

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
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller)),
    Layer.provideMerge(liveThreadsLayer),
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
