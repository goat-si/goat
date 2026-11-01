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
import { authorityReporter, type AuthorityListener } from "../preview/ServerBrowserScreen.ts";
import { SessionControl } from "../preview/SessionControl.ts";
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

// Mirrors ServerBrowser: the tab's real control and authority reporter fire when close() drops
// the owner, then the dropped tab reports Stop, all before the close replies. A closed tab leaves
// the live list, so an exact status for it finds no host.
const temporaryTabFixture = (beforeClose?: (control: SessionControl) => void) => {
  const state = {
    open: false,
    opens: 0,
    closes: 0,
    changed: undefined as AuthorityListener | undefined,
    control: undefined as SessionControl | undefined,
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
          state.opens++;
          const control = new SessionControl("agent");
          control.onChange(
            authorityReporter(
              { control, threadId: "thread" as ThreadId, tabId: tab.tabId },
              (change) => state.changed?.(change),
            ),
          );
          state.control = control;
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
          if (state.closes === 1 && state.control) beforeClose?.(state.control);
          void state.control?.close();
          state.changed?.({
            kind: "stop",
            reason: "tabClosed",
            threadId: "thread",
            tabId: tab.tabId,
          });
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
        getThreadRecords: (() =>
          Effect.succeed({
            runs: [{ id: "run", status: "running" }],
          } as unknown as OrchestrationV2ThreadProjection)) as never,
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
      ).toMatchObject({ category: "unverifiable" });
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

it.live("a person's Stop during own-tab close cuts the cell before it opens another tab", () => {
  const fixture = temporaryTabFixture((control) => control.stopAgents());
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(fixture.broker);
    return yield* Effect.gen(function* () {
      const service = yield* fixture.service;
      const result = yield* service
        .runCell({
          ...fixture.request,
          source:
            "const tab = await screen.openTab({url: 'https://example.test/'}); await tab.close(); const next = await screen.openTab({url: 'https://example.test/after-stop'}); await next.close(); return 'continued';",
        })
        .pipe(Effect.result);
      expect(fixture.state.opens, JSON.stringify(result)).toBe(1);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(fixture.layer(tabHost)));
  });
});

it.live("a screen guest has no ambient filesystem or network APIs", () => {
  const fixture = temporaryTabFixture();
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(fixture.broker);
    return yield* Effect.gen(function* () {
      const service = yield* fixture.service;
      const result = yield* service.runCell({
        ...fixture.request,
        source: `
          const globals = [typeof process, typeof require, typeof fetch, typeof WebSocket,
            typeof XMLHttpRequest, typeof Deno, typeof Bun, typeof std, typeof os];
          const constructorProcess = ({}).constructor.constructor('return typeof process')();
          const imports = [];
          for (const name of ['node:fs', 'node:http']) {
            try { await import(name); imports.push('loaded'); }
            catch { imports.push('denied'); }
          }
          return {globals, constructorProcess, imports};
        `,
      });
      expect(result.status).toBe("completed");
      expect(result.value).toEqual({
        globals: Array(9).fill("undefined"),
        constructorProcess: "undefined",
        imports: ["denied", "denied"],
      });
      expect(fixture.state.opens).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer(tabHost)));
  });
});
