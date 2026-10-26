import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  PreviewTabId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { ScreenCursorPublisher } from "../cua/ScreenCursorPublisher.ts";
import type { ComputerUseCursorEvent } from "@goat/contracts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set<"preview">(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
};

it.live(
  "a live cell host call publishes thinking for its bound target and hidden at finishTurn",
  () => {
    const events: ComputerUseCursorEvent[] = [];
    const targetRef = {
      id: "target",
      kind: "tab" as const,
      environmentId: "env",
      runId: "run",
      turnId: "turn",
      generation: 0,
    };
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        invocation: {
          ...invocation,
          capabilities: new Set(["preview" as const]),
          reauthorize: () => Effect.void,
        },
        source: "const tab = await screen.tab({tabId: 'tab'}); await tab.observe(); return true;",
      });
      expect(result.value).toBe(true);
      yield* service.finishTurn({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
      expect(events.map((event) => `${event.identity.targetId}:${event.phase}`)).toEqual([
        "target:thinking",
        "target:resting",
        "target:hidden",
      ]);
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          dispatcher: {
            availability: () => Effect.succeed([{ kind: "tab", available: true }]),
            dispatch: (call) =>
              Effect.succeed(
                call.method === "select_tab"
                  ? {
                      value: {
                        targetRef,
                        tab: { tabId: "tab", title: "Page", url: "https://example.test/" },
                      },
                      category: "confirmed" as const,
                    }
                  : { value: { indexedText: "Page" }, category: "confirmed" as const },
              ),
          },
        }).pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(
              ScreenCursorPublisher,
              ScreenCursorPublisher.of({
                publish: (event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "the service layer starts without WASM and the first cell fails runtime_unavailable",
  () =>
    Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service
        .runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return 1;",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("runtime_unavailable");
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: { command: process.execPath, entrypoint: "/tmp/goat-screen-test-entry.ts" },
          assetResolver: () =>
            resolveScreenRuntimeAsset("dev", {
              devPath: "/tmp/goat-screen-missing/quickjs.wasm",
            }),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
);

it.effect("a terminal run during asset resolution refuses the starting cell without spawning", () =>
  Effect.gen(function* () {
    const resolving = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* Effect.provide(
      ScreenRunService,
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () =>
          Deferred.succeed(resolving, undefined).pipe(
            Effect.flatMap(() => Deferred.await(release)),
            Effect.flatMap(() => resolveScreenRuntimeAsset("dev")),
          ),
      }).pipe(Layer.provide(NodeServices.layer)),
    );
    const pending = yield* Effect.forkChild(
      service
        .runCell({
          runId: "race",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return 1;",
        })
        .pipe(Effect.result),
    );
    yield* Deferred.await(resolving);
    yield* service.finishRun({ threadId: "thread", runId: "race", reason: "turnEnded" });
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("stale_run");
  }),
);

it.live("a later cell uses the renewed invocation for preview reauthorization", () =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
      source: "return 1;",
    });
    const renewed = {
      ...invocation,
      capabilities: new Set(["preview" as const]),
      reauthorize: () => Effect.void,
    };
    const source = `return await screen.click({targetRef: ${JSON.stringify({
      id: "target",
      kind: "tab",
      environmentId: "env",
      runId: "r",
      turnId: "t",
      generation: 0,
    })}});`;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: renewed,
      source,
    });
    expect(result.value).toBe(true);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "tab", available: true }]),
          dispatch: () =>
            Effect.succeed({ value: true, category: "confirmed", evidence: ["observation:o"] }),
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.live("asset failure is retried and a successful load is cached", () => {
  let attempts = 0;
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const request = {
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
      source: "return 1;",
    };
    const first = yield* service.runCell(request).pipe(Effect.result);
    expect(first._tag).toBe("Failure");
    const second = yield* service.runCell(request);
    const third = yield* service.runCell(request);
    expect(second.value).toBe(1);
    expect(third.value).toBe(1);
    expect(attempts).toBe(2);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () =>
          ++attempts === 1
            ? resolveScreenRuntimeAsset("dev", { devPath: "/tmp/goat-screen-missing/quickjs.wasm" })
            : resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live("later cells may lower limits while preserving turn values", () =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const request = {
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
    };
    const first = yield* service.runCell({
      ...request,
      source: "screen.values.count = 5; return 5;",
    });
    const second = yield* service.runCell({
      ...request,
      limits: { callsPerCell: 1 },
      source: "return screen.values.count;",
    });
    expect(first.value).toBe(5);
    expect(second.value).toBe(5);
    yield* service.finishTurn({ ...request, reason: "test" });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.live("a thrown guest error is a failed cell and leaves values for the next cell", () =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const request = {
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
    };
    const failed = yield* service.runCell({
      ...request,
      source: "screen.values.count = 3; throw new Error('boom');",
    });
    expect(failed).toMatchObject({ status: "failed", error: { name: "Error", message: "boom" } });
    const next = yield* service.runCell({ ...request, source: "return screen.values.count;" });
    expect(next.value).toBe(3);
    yield* service.finishTurn({ ...request, reason: "test" });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.live("one cell reads a tab and an app through one Target API", () => {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("tab"),
    title: "Page",
    url: "https://example.test/",
    owner: "unclaimed" as const,
    ownedByCaller: false,
    controlGeneration: 0,
  };
  const calls: string[] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () =>
      Effect.sync(() => {
        calls.push("list_tabs");
        return [tab];
      }),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        calls.push(request.operation);
        return (
          request.operation === "status"
            ? {
                tabId: tab.tabId,
                url: tab.url,
                control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
              }
            : {
                url: tab.url,
                title: "Page",
                loading: false,
                visibleText: "Tab text",
                interactiveElements: [],
                accessibilityTree: "- heading Page",
                consoleEntries: [],
                networkEntries: [],
                actionTimeline: [],
                treeComplete: true,
                refGeneration: "1",
              }
        ) as A;
      }),
  };
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(broker);
    const appHost = {
      availability: () => Effect.succeed([{ kind: "app" as const, available: true }]),
      dispatch: (call: { method: string }) =>
        Effect.sync(() => {
          calls.push(call.method);
          if (call.method === "bind_app")
            return {
              value: {
                targetRef: {
                  id: "app",
                  kind: "app",
                  environmentId: "env",
                  runId: "r",
                  turnId: "t",
                  generation: 0,
                },
              },
              category: "confirmed" as const,
              evidence: ["App bound"],
            };
          return {
            value: { text: "App text" },
            category: "confirmed" as const,
            evidence: ["App observed"],
          };
        }),
    };
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: {
          ...invocation,
          capabilities: new Set(["preview" as const]),
          reauthorize: () => Effect.void,
        },
        bindingHints: {
          browserRequested: true,
          computerRequested: true,
          appIds: ["app"],
          tabs: [
            {
              mentionId: "mention",
              environmentId: "env",
              browserInstanceId: "server-browser",
              tabId: "tab",
              titleAtMention: "Page",
              urlAtMention: "https://example.test/",
            },
          ],
        },
        source:
          "const tab = await screen.tab({mentionId: 'mention'}); const app = await screen.app({appId: 'app'}); const web = await tab.observe(); const desktop = await app.observe(); return [web.indexedText, desktop.text];",
      });
      expect(result.value).toEqual(["- heading Page", "App text"]);
      expect(calls.slice(0, 5)).toEqual([
        "list_tabs",
        "bind_app",
        "status",
        "snapshot",
        "get_accessibility_tree",
      ]);
      expect(result.journal.map((entry) => entry.receipt.method)).toEqual([
        "select_tab",
        "bind_app",
        "observe",
        "get_accessibility_tree",
      ]);
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: appHost, tab: tabHost }),
          tabHost,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  });
});
