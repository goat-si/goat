import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnItemId, type EnvironmentId, type ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";

import { ComputerUseCallApps, makeCallApps } from "../cua/ComputerUseCallApps.ts";
import { ScreenCursorPublisher } from "../cua/ScreenCursorPublisher.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { fixture as desktopFixture } from "./DesktopTargetHost.testkit.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set(["preview" as const]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
  reauthorize: () => Effect.void,
};

const page = { _tag: "website", pageUrl: "https://example.test/" } as const;
const bindAndObserve = "const tab = await screen.tab({tabId: 'tab'}); await tab.observe();";
const request = {
  runId: "run",
  turnId: "turn",
  threadId: "thread",
  environmentId: "env",
  invocation,
};

/** The row a provider that keeps only a summary records for a cell that ran `code`. */
const summaryRow = (code: string, status: "completed" | "failed" = "completed") => ({
  id: TurnItemId.make("cell-row"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status,
  title: null,
  toolName: "goat.goat_screen_run",
  input: { code },
  output: "Ran the screen cell.",
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00.000Z"),
});

/** Runs `program` against a live screen runtime whose only tab is bound as "target". */
const withScreen = <A, E>(
  program: (callApps: ReturnType<typeof makeCallApps>) => Effect.Effect<A, E, ScreenRunService>,
) => {
  const callApps = makeCallApps();
  callApps.screenTarget("target", { kind: "tab", pageUrl: page.pageUrl });
  return program(callApps).pipe(
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
                      targetRef: {
                        id: "target",
                        kind: "tab" as const,
                        environmentId: "env",
                        runId: "run",
                        turnId: "turn",
                        generation: 0,
                      },
                      tab: { tabId: "tab", title: "Page", url: page.pageUrl },
                    },
                    category: "confirmed" as const,
                  }
                : { value: { indexedText: "Page" }, category: "confirmed" as const },
            ),
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
    Effect.provideService(ComputerUseCallApps, callApps),
  );
};

it.live("keeps a stored app usable across cells after rebinding its window and other apps", () => {
  const { host } = desktopFixture({
    list_apps: {
      apps: [
        { pid: 42, name: "Editor", bundle_id: "org.example.Editor" },
        { pid: 43, name: "Other", bundle_id: "org.example.Other" },
      ],
    },
    list_windows: {
      windows: [
        { pid: 42, window_id: 7, title: "First" },
        { pid: 42, window_id: 8, title: "Second" },
        { pid: 43, window_id: 9, title: "Other" },
      ],
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const first = yield* service.runCell({
      ...request,
      source:
        "screen.state.app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); return true;",
    });
    expect(first.status).toBe("completed");
    const second = yield* service.runCell({
      ...request,
      source:
        "const again = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); const other = await screen.app({bundle_id: 'org.example.Editor', window_id: 8}); await screen.app({bundle_id: 'org.example.Other', window_id: 9}); return [again.targetRef.id === screen.state.app.targetRef.id, other.targetRef.id !== again.targetRef.id];",
    });
    expect(second.value).toEqual([true, true]);
    const third = yield* service.runCell({
      ...request,
      source:
        "await screen.state.app.observe(); await screen.state.app.click('Apply'); return true;",
    });
    expect(third.status).toBe("completed");
    expect(third.value).toBe(true);
    yield* service.finishTurn({ ...request, reason: "test" });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        desktopHost: host,
        dispatcher: createScreenDispatchRouter({ app: host }),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
    Effect.provideService(ComputerUseCallApps, makeCallApps()),
  );
});

it.live("a cell's row names the target it acted on even when its provider keeps a summary", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const source = `${bindAndObserve} return true;`;
      const result = yield* (yield* ScreenRunService).runCell({ ...request, source });
      expect(result.value).toBe(true);
      expect(callApps.present(summaryRow(source)).toolIcon).toEqual(page);
    }),
  ),
);

it.live("a cell that fails after acting on a target still names it", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const source = `${bindAndObserve} throw new Error("boom");`;
      const result = yield* (yield* ScreenRunService).runCell({ ...request, source });
      expect(result.status).toBe("failed");
      expect(callApps.present(summaryRow(source, "failed")).toolIcon).toEqual(page);
    }),
  ),
);

it.live("a refused repeat of a cell's code does not take the earlier cell's targets", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const source = `${bindAndObserve} return true;`;
      yield* service.runCell({ ...request, source });
      const refused = yield* service
        .runCell({ ...request, source, limits: { sourceBytes: 1 } })
        .pipe(Effect.flip);
      expect(refused.code).toBe("source_limit");
      const row = summaryRow(source, "failed");
      expect(callApps.present(row)).toBe(row);
    }),
  ),
);

it.live(
  "serializes cursor publications per route across rebinds, keeps the cursor across a failed cell, and drains at turn end",
  () => {
    const events: string[] = [];
    let nextId = 0;
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const failed = yield* service.runCell({
        ...request,
        source: `${bindAndObserve} throw new Error("boom");`,
      });
      expect(failed.status).toBe("failed");
      expect(events).toEqual(["t-1:1:thinking", "t-1:1:resting"]);
      const second = yield* service.runCell({
        ...request,
        source: `${bindAndObserve} return true;`,
      });
      expect(second.status).toBe("completed");
      yield* service.finishTurn({ ...request, reason: "test" });
      expect(events).toEqual([
        "t-1:1:thinking",
        "t-1:1:resting",
        "t-2:2:thinking",
        "t-2:2:resting",
        "t-1:1:hidden",
        "t-2:2:hidden",
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
                        targetRef: {
                          id: `t-${++nextId}`,
                          kind: "tab" as const,
                          environmentId: "env",
                          runId: "run",
                          turnId: "turn",
                          generation: nextId,
                        },
                        tab: { tabId: "tab", title: "Page", url: page.pageUrl },
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
                    events.push(
                      `${event.identity.targetId}:${event.identity.generation}:${event.phase}`,
                    );
                  }),
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(ComputerUseCallApps, makeCallApps()),
    );
  },
);

it.live(
  "wires ScreenCursorPhases into DesktopTargetHost so A -> B -> A desktop window switches advance call generations",
  () => {
    const { host, sent } = desktopFixture({
      list_apps: {
        apps: [{ pid: 42, name: "Editor", bundle_id: "org.example.Editor" }],
      },
      list_windows: {
        windows: [
          {
            pid: 42,
            window_id: 7,
            title: "First",
            bounds: { x: 0, y: 0, width: 400, height: 200 },
          },
          {
            pid: 42,
            window_id: 8,
            title: "Second",
            bounds: { x: 0, y: 0, width: 400, height: 200 },
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        ...request,
        source: [
          "const a = await screen.app({bundleId: 'org.example.Editor', windowId: 7});",
          "const b = await screen.app({bundleId: 'org.example.Editor', windowId: 8});",
          "await a.press('Escape');",
          "await b.press('Escape');",
          "await a.press('Escape');",
          "return true;",
        ].join(" "),
      });
      expect(result.status).toBe("completed");
      const generations = sent
        .filter((entry) => entry.tool === "press_key")
        .map((entry) => (entry.cursor?.owner as { generation: number } | undefined)?.generation);
      expect(generations).toEqual([1, 2, 3]);
      yield* service.finishTurn({ ...request, reason: "test" });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          desktopHost: host,
          dispatcher: createScreenDispatchRouter({ app: host }),
        }).pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(
              ScreenCursorPublisher,
              ScreenCursorPublisher.of({ publish: () => Effect.void }),
            ),
          ),
        ),
      ),
      Effect.provideService(ComputerUseCallApps, makeCallApps()),
    );
  },
);
