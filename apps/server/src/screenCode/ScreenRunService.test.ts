import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import {
  PreviewTabId,
  SCREEN_TARGET_CONTRACT_VERSION,
  screenTargetApi,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { ScreenCursorPublisher } from "../cua/ScreenCursorPublisher.ts";
import type { AgentCursorEvent } from "@goat/contracts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { fixture } from "./DesktopTargetHost.testkit.ts";
import * as SiteNotes from "../preview/SiteNotes.ts";
import { runMigrations } from "../persistence/Migrations.ts";

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

it.live("a tab binding receives a saved note once across cells", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const notes = yield* SiteNotes.SiteNotes;
      yield* notes.write({ origin: "https://example.test", text: "saved procedure", author: "person" });
      const targetRef = { id: "target", kind: "tab" as const, environmentId: "env", runId: "r", turnId: "t", generation: 0 };
      const dispatcher = {
        availability: () => Effect.succeed([{ kind: "tab" as const, available: true }]),
        dispatch: () => Effect.succeed({ value: { targetRef, tab: { tabId: "tab", title: "Page", url: "https://example.test/" } }, category: "confirmed" as const }),
      };
      yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const request = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env", invocation: { ...invocation, capabilities: new Set(["preview" as const]), reauthorize: () => Effect.void } };
        const first = yield* service.runCell({ ...request, source: "return (await screen.tab({tabId: 'tab'})).note;" });
        expect(first.value).toContain("saved procedure");
        const second = yield* service.runCell({ ...request, source: "return (await screen.tab({tabId: 'tab'})).note ?? null;" });
        expect(second.value).toBeNull();
        yield* service.finishTurn({ ...request, reason: "test" });
      }).pipe(Effect.provide(ScreenRunService.layerWithRuntime({
        dispatcher,
        invocation: { command: process.execPath, entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)) },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer))));
    }).pipe(Effect.provide(SiteNotes.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.live(
  "a live cell host call publishes thinking for its bound target and hidden at finishTurn",
  () => {
    const events: AgentCursorEvent[] = [];
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

it.live("a cell's end cancels its gave-up driver calls before the turn takes its next cell", () => {
  const cancelling = Deferred.makeUnsafe<void>();
  const gate = Deferred.makeUnsafe<void>();
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
    const first = yield* service.runCell(request).pipe(Effect.forkChild);
    yield* Deferred.await(cancelling);
    const next = yield* service.runCell(request).pipe(Effect.flip);
    expect(next.code).toBe("pending_limit");
    yield* Deferred.succeed(gate, undefined);
    expect((yield* Fiber.join(first)).value).toBe(1);
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        primitiveChannel: {
          cancel: () =>
            Deferred.succeed(cancelling, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        } as never,
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

it.live("a later cell that lowers turnWasmBytes runs under that cap in a fresh child", () =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const request = {
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
    };
    const allocate =
      "const parts = []; for (let i = 0; i < 12; i++) parts.push('x'.repeat(1024 * 1024) + i); return parts.length;";
    const first = yield* service.runCell({ ...request, source: allocate });
    const lowered = yield* service.runCell({
      ...request,
      limits: { turnWasmBytes: 16 * 1024 * 1024 },
      source: allocate,
    });
    expect(first.value).toBe(12);
    expect(lowered.status).toBe("resource_exhausted");
    expect(lowered.truncated).toContain("context_reset");
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
          "const tab = await screen.tab({mentionId: 'mention'}); const app = await screen.app({bundle_id: 'app', window_id: 1}); const web = await tab.observe(); const desktop = await app.observe(); return [web.indexedText, desktop.text];",
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

it.live("a cell binds a tab by its id string and catches a failed call as a ScreenError", () => {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("tab_1"),
    title: "Page",
    url: "https://example.test/",
    owner: "unclaimed" as const,
    ownedByCaller: false,
    controlGeneration: 0,
  };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([tab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      request.operation === "status"
        ? Effect.succeed({
            tabId: tab.tabId,
            url: tab.url,
            control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
          } as A)
        : Effect.die("only status is expected"),
  };
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(broker);
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const request = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
      const result = yield* service.runCell({
        ...request,
        invocation: {
          ...invocation,
          capabilities: new Set(["preview" as const]),
          reauthorize: () => Effect.void,
        },
        source: `const tab = await screen.tab("tab_1");
          try { await tab.click({ ref: "missing" }); return "clicked"; }
          catch (error) {
            return [error instanceof Error, error.name, typeof error.code, error.effectStarted, typeof error.message];
          }`,
      });
      expect(result.status).toBe("completed");
      expect(result.value).toEqual([true, "ScreenError", "string", false, "string"]);
      expect(result.journal.map((entry) => entry.receipt.method)).toEqual(["select_tab", "click"]);
      yield* service.finishTurn({ ...request, reason: "test" });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ tab: tabHost }),
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

it.live(
  "one cell drives a tab and an app through the same Target methods and keeps driver detail",
  () => {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Page",
      url: "https://shopping.naver.com/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const clicks: unknown[] = [];
    const drags: unknown[] = [];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.sync(() => {
          if (request.operation === "click") clicks.push(request.input);
          if (request.operation === "drag") drags.push(request.input);
          return (
            request.operation === "status"
              ? {
                  tabId: tab.tabId,
                  url: tab.url,
                  control: { owner: "unclaimed", ownedByCaller: false, generation: 0 },
                }
              : request.operation === "snapshot"
                ? {
                    url: tab.url,
                    title: "Page",
                    loading: false,
                    visibleText: "",
                    interactiveElements: [],
                    accessibilityTree: '- button "Add Element" [ref=e1]\n- link "Home" [ref=e2]',
                    consoleEntries: [],
                    networkEntries: [],
                    actionTimeline: [],
                    treeComplete: true,
                    refGeneration: "1",
                  }
                : {}
          ) as A;
        }),
    };
    const desktop = fixture({
      get_window_state: {
        pid: 42,
        window_id: 7,
        snapshot_id: "s1",
        elements_complete: true,
        tree_markdown:
          '- [0] AXWindow "Document"\n  - [1] AXButton "Apply" [actions=[press]]\n  - [2] AXSlider "Volume"',
        elements: [
          {
            role: "AXWindow",
            label: "Document",
            element_index: 0,
            element_token: "s1:0",
            frame: { x: 300, y: 200, w: 600, h: 400 },
          },
          {
            role: "AXButton",
            label: "Apply",
            element_index: 1,
            element_token: "s1:1",
            actions: ["press"],
            enabled: true,
            selected: false,
            frame: { x: 310, y: 220, w: 80, h: 24 },
            parent_index: 0,
          },
          {
            role: "AXSlider",
            label: "Volume",
            element_index: 2,
            element_token: "s1:2",
            value: "40",
            min: 0,
            max: 100,
            parent_index: 0,
          },
        ],
      },
      verify_state: { status: "satisfied" },
    });
    return Effect.gen(function* () {
      const tabHost = yield* makePreviewTargetHost(broker);
      return yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const request = {
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: {
            ...invocation,
            capabilities: new Set(["preview" as const]),
            reauthorize: () => Effect.void,
          },
        };
        const result = yield* service.runCell({
          ...request,
          source: `
        const tab = await screen.tab({tabId: 'tab'});
        await tab.claim();
        const page = await tab.observe({interactiveOnly: true});
        const clicks = [];
        for (let i = 0; i < 3; i++) clicks.push((await tab.click(0)).verdict);
        clicks.push((await tab.click('text=Home')).verdict);
        const dragged = (await tab.drag(0, 1)).verdict;
        const fields = {kind: tab.kind, identity: typeof tab.identity, generation: typeof tab.generation, owner: tab.owner, reads: tab.capabilities.includes('read')};
        const app = await screen.app({bundle_id: 'org.example.Editor'});
        const tree = await app.observe();
        let pointRefusal;
        try { await app.click([10, 10]); } catch (error) { pointRefusal = {code: error.code, nothingSent: error.nothingSent}; }
        const applied = (await app.click({role: 'AXButton', name: 'Apply'})).verdict;
        const menu = (await app.menu(['File', 'Save'])).verdict;
        const ready = await app.waitFor({role: 'AXButton', name: 'Apply'});
        let missing;
        try { await app.click(99); } catch (error) { missing = {name: error.name, code: error.code, nothingSent: error.nothingSent}; }
        return {pageText: page.text, clicks, dragged, fields, pointRefusal, tabNote: tab.note !== undefined, elements: tree.elements, applied, menu, ready: ready.met, missing};
      `,
        });
        expect(result.status).toBe("completed");
        expect(result.api).toContain("interface App extends TargetBase");
        expect(result.contractVersion).toBe(SCREEN_TARGET_CONTRACT_VERSION);
        expect(result.value).toMatchObject({
          pageText: '- button "Add Element" [0]\n- link "Home" [1]',
          clicks: ["unverifiable", "unverifiable", "unverifiable", "unverifiable"],
          tabNote: false,
          // An app point needs a current screenshot; nothing goes to the driver without one.
          pointRefusal: { code: "invalid_argument", nothingSent: true },
          dragged: "unverifiable",
          fields: {
            kind: "tab",
            identity: "string",
            generation: "number",
            owner: "unclaimed",
            reads: true,
          },
          applied: "confirmed",
          menu: "confirmed",
          ready: true,
          missing: { name: "ScreenError", code: "stale_reference", nothingSent: true },
        });
        // The same number clicks three times: refs hold until the next observe.
        expect(clicks).toEqual([
          expect.objectContaining({ locator: "aria-ref=e1" }),
          expect.objectContaining({ locator: "aria-ref=e1" }),
          expect.objectContaining({ locator: "aria-ref=e1" }),
          expect.objectContaining({ locator: "text=Home" }),
        ]);
        expect(drags).toEqual([
          expect.objectContaining({ source: "aria-ref=e1", target: "aria-ref=e2" }),
        ]);
        // DSH-11: the driver's actions, state, geometry (in window points), range and parent reach the cell.
        expect((result.value as { elements: unknown[] }).elements).toEqual([
          expect.objectContaining({ index: 0, role: "AXWindow", name: "Document" }),
          expect.objectContaining({
            index: 1,
            name: "Apply",
            actions: ["press"],
            enabled: true,
            selected: false,
            frame: { x: 10, y: 20, width: 80, height: 24 },
            parent: 0,
          }),
          expect.objectContaining({ index: 2, text: "40", range: { min: 0, max: 100 }, parent: 0 }),
        ]);
        expect(
          desktop.sent
            .map((sent) => sent.tool)
            .filter((tool) => tool !== "list_windows" && tool !== "verify_state"),
        ).toEqual(["list_apps", "list_apps", "get_window_state", "click", "invoke_menu"]);
        const sentClick = desktop.sent.find((sent) => sent.tool === "click");
        const sentMenu = desktop.sent.find((sent) => sent.tool === "invoke_menu");
        expect(sentClick?.args).toMatchObject({ element_token: "s1:1" });
        expect(sentClick?.args).not.toHaveProperty("targetRef");
        expect(sentMenu?.args).toEqual({ pid: 42, window_id: 7, path: ["File", "Save"] });
        expect(desktop.sent.at(-1)?.args).toMatchObject({
          expect: [
            { element: { selector: { role: "AXButton", label_contains: "Apply" }, exists: true } },
          ],
        });

        const failed = yield* service.runCell({
          ...request,
          source: `
        const tab = await screen.tab({tabId: 'tab'});
        await tab.observe();
        await tab.click(5);
      `,
        });
        expect(failed.status).toBe("failed");
        expect(failed.api).toBeUndefined();
        expect(failed.error).toMatchObject({ name: "ScreenError" });
        expect(failed.error?.message).toMatch(/^stale_reference \(nothing sent\)/);
        expect(failed.value).toMatchObject({ partial: [{ call: "observe" }] });
        yield* service.finishTurn({ ...request, reason: "test" });
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher: createScreenDispatchRouter({ app: desktop.host, tab: tabHost }),
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
  },
);

it.live(
  "a thread gets the API for the surfaces it has, again when one appears, after reset and in a new session",
  () => {
    let appAvailable = false;
    const request = {
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
      source: "return 1;",
    };
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const first = yield* service.runCell(request);
      expect(first.contractVersion).toBe(SCREEN_TARGET_CONTRACT_VERSION);
      expect(first.api).toContain(`contract ${SCREEN_TARGET_CONTRACT_VERSION}`);
      expect(first.api).toContain("interface Tab extends TargetBase");
      expect(first.api).not.toContain("interface App");
      const neither = screenTargetApi({ app: false, tab: false });
      expect(neither).not.toContain("interface Tab");
      expect(neither).not.toContain("interface App");
      expect(neither).toContain("screen.tab() is unavailable");
      expect((yield* service.runCell(request)).api).toBeUndefined();
      appAvailable = true;
      expect((yield* service.runCell(request)).api).toContain("interface App extends TargetBase");
      expect((yield* service.runCell(request)).api).toBeUndefined();
      appAvailable = false;
      const reset = yield* service.runCell({ ...request, resetValues: true });
      // The bundle follows what the turn has now, not what it had before.
      expect(reset.api).toContain("interface Tab extends TargetBase");
      expect(reset.api).not.toContain("interface App");
      expect(reset.api).toContain("screen.app() is unavailable");
      appAvailable = true;
      const reconnected = yield* service.runCell({
        ...request,
        invocation: { ...invocation, thread: { ...invocation.thread, providerSessionId: "s2" } },
      });
      expect(reconnected.api).toContain("interface App extends TargetBase");
      yield* service.finishTurn({ ...request, reason: "test" });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          dispatcher: {
            availability: () =>
              Effect.sync(() => [
                { kind: "tab" as const, available: true },
                appAvailable
                  ? { kind: "app" as const, available: true }
                  : { kind: "app" as const, available: false, reason: "no_lease" as const },
              ]),
            dispatch: () =>
              Effect.fail({
                code: "unsupported" as const,
                effectStarted: false,
                nextStep: "Unused.",
              }),
          },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

it.live("a second cell in a busy turn is refused and Stop still cuts the running one", () =>
  Effect.gen(function* () {
    const offered = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    const serviceLayer = ScreenRunService.layerWithRuntime({
      invocation: {
        command: process.execPath,
        entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      },
      assetResolver: () => resolveScreenRuntimeAsset("dev"),
      dispatcher: {
        availability: () => Effect.succeed([{ kind: "app", available: true }]),
        dispatch: () =>
          Deferred.succeed(offered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(held)),
            Effect.as({ value: true, category: "confirmed" as const }),
          ),
      },
    }).pipe(Layer.provide(NodeServices.layer));
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const request = {
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        invocation,
      };
      const first = yield* service
        .runCell({ ...request, source: "return await screen.list_apps();" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(offered);
      const second = yield* service
        .runCell({ ...request, source: "return 1;" })
        .pipe(Effect.result);
      expect(second._tag === "Failure" ? second.failure.code : undefined).toBe("pending_limit");
      yield* service.fence({ threadId: "thread" });
      const cut = yield* Fiber.join(first);
      // Joined before the held dispatch is released: the fence ended the cell that was running.
      expect(cut._tag === "Failure" || cut.success.status !== "completed").toBe(true);
      yield* Deferred.succeed(held, undefined);
      yield* service.finishTurn({ ...request, reason: "test" });
    }).pipe(Effect.provide(serviceLayer));
  }),
);
