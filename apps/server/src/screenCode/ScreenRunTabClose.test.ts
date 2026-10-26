import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  PreviewAutomationNoAvailableHostError,
  PreviewTabId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const context = {
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "session",
      providerInstanceId: "provider" as ProviderInstanceId,
    },
    reauthorize: () => Effect.void,
  },
};

// Mirrors ServerBrowser: a close reports Stop for the tab before it replies, and a closed tab
// leaves the live list, so an exact status for it finds no host.
const temporaryTabFixture = () => {
  const state = {
    open: false,
    closes: 0,
    changed: undefined as
      | ((change: { kind: "stop"; threadId: string; tabId: string }) => void)
      | undefined,
    commands: [] as Array<{ readonly type: string }>,
  };
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("temporary"),
    title: "Page",
    url: "https://example.test/",
    owner: "agent" as const,
    ownedByCaller: true,
    controlGeneration: 1,
  };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.sync(() => (state.open ? [tab] : [])),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.suspend(() => {
        if (request.operation === "open") {
          state.open = true;
          return Effect.succeed({ tabId: tab.tabId } as A);
        }
        if (!state.open)
          return Effect.fail(
            new PreviewAutomationNoAvailableHostError({
              operation: request.operation,
              environmentId: "env" as EnvironmentId,
              threadId: "thread" as ThreadId,
              providerSessionId: "session",
              providerInstanceId: "provider" as ProviderInstanceId,
            }),
          );
        if (request.operation === "close") {
          state.closes++;
          state.changed?.({ kind: "stop", threadId: "thread", tabId: tab.tabId });
          state.open = false;
          return Effect.succeed({} as A);
        }
        return Effect.succeed({
          tabId: tab.tabId,
          url: tab.url,
          control: { owner: "agent", ownedByCaller: true, generation: 1 },
        } as A);
      }),
  };
  const layer = (tabHost: Effect.Success<ReturnType<typeof makePreviewTargetHost>>) =>
    Layer.merge(
      ScreenRunService.layerWithRuntime({
        tabHost,
        dispatcher: tabHost,
        browser: {
          onAuthorityChange: (listener) => {
            state.changed = listener;
            return () => {
              state.changed = undefined;
            };
          },
        },
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () =>
          Effect.succeed({
            runs: [{ id: "run", status: "running" }],
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Effect.sync(() => {
            state.commands.push(command);
            return { sequence: 0 } as never;
          }),
      }),
    ).pipe(Layer.provide(NodeServices.layer));
  const request = {
    runId: "run",
    turnId: "turn",
    threadId: "thread",
    environmentId: "env",
    invocation: context.invocation,
  };
  const notices = () => state.commands.filter((command) => command.type === "thread.notice.record");
  // A failed expectation still ends the turn, so no screen child outlives the test.
  const service = Effect.gen(function* () {
    const screen = yield* ScreenRunService;
    yield* Effect.addFinalizer(() =>
      screen.finishTurn({ ...request, reason: "test cleanup" }).pipe(Effect.ignore),
    );
    return screen;
  });
  return { state, broker, layer, request, notices, service };
};

it.live("a cell that closes its own temporary tab completes and posts no cleanup notice", () => {
  const fixture = temporaryTabFixture();
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(fixture.broker);
    return yield* Effect.gen(function* () {
      const service = yield* fixture.service;
      const result = yield* service.runCell({
        ...fixture.request,
        source:
          "const tab = await screen.openTab({url: 'https://example.test/'}); await tab.close(); return 'closed';",
      });
      expect(result.status).toBe("completed");
      expect(result.value).toBe("closed");
      expect(fixture.state.closes).toBe(1);
      expect(
        result.journal.find((entry) => entry.receipt.method === "close_tab")?.receipt,
      ).toMatchObject({ category: "confirmed" });
      expect(yield* service.journalSnapshot(fixture.request)).toEqual([]);
      yield* service.finishTurn({ ...fixture.request, reason: "test" });
      expect(fixture.state.closes).toBe(1);
      expect(fixture.notices()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer(tabHost)));
  });
});

it.live("a person closing an agent tab counts as closed and posts no cleanup notice", () => {
  const fixture = temporaryTabFixture();
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(fixture.broker);
    return yield* Effect.gen(function* () {
      const service = yield* fixture.service;
      const opened = yield* service.runCell({
        ...fixture.request,
        source: "return (await screen.openTab({url: 'https://example.test/'})).targetRef;",
      });
      expect(opened.status).toBe("completed");
      // The person's close removes the tab first; the cleanup that follows finds it gone.
      fixture.state.open = false;
      const stop = yield* service.controlChanged({
        kind: "stop",
        threadId: "thread",
        tabId: "temporary",
      });
      expect(stop.cleanupFailures).toBe(0);
      expect(yield* service.journalSnapshot(fixture.request)).toEqual([]);
      yield* service.finishTurn({ ...fixture.request, reason: "test" });
      expect(fixture.state.closes).toBe(0);
      expect(fixture.notices()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer(tabHost)));
  });
});
