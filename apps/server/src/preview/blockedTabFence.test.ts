import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { makeBlockedTabFence } from "./blockedTabFence.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a late observation cannot fence a later turn with the same run id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const snapshot = yield* settings.getSettings;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      const delayed = Effect.suspend(() => {
        if (!first) return Effect.succeed(snapshot);
        first = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(snapshot),
        );
      });
      const fence = yield* makeBlockedTabFence().pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          getSettings: delayed,
        }),
      );
      const threadId = ThreadId.make("fence-thread");
      const tab = {
        threadId,
        tabId: "tab",
        closing: false,
        page: { frames: () => [{ url: () => "https://safe.example/" }] },
      };
      const end = yield* activity.begin(threadId, "run");
      const captured = fence.capture(threadId)!;
      const observation = fence.observe(tab, "https://example.com/");
      expect(observation).toBeDefined();
      yield* Deferred.await(entered);
      yield* end;
      const endNext = yield* activity.begin(threadId, "run");
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => observation!);
      yield* Effect.promise(() => fence.observe(tab, "https://example.com/", captured)!);
      yield* Effect.promise(() => fence.assertTab(tab, "run"));
      yield* endNext;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-blocked-fence-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a blocked visit cuts an input already dispatching", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("fence-cut-thread");
      const end = yield* activity.begin(threadId, "run");
      const control = new SessionControl("agent");
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let cuts = 0;
      control.onDispatchCut(() => {
        cuts++;
      });
      const action = control.agent("agent", async () => {
        control.dispatchGate()();
        started.resolve();
        await release.promise;
      });
      void action.catch(() => undefined);
      yield* Effect.promise(() => started.promise);
      const tab = {
        threadId,
        tabId: "tab",
        closing: false,
        control,
        page: { frames: () => [{ url: () => "https://safe.example/" }] },
      };
      yield* Effect.promise(() => fence.observe(tab, "https://example.com/")!);
      expect(cuts).toBe(1);
      const result = yield* Effect.promise(() =>
        action.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({ reason: "blocked_url", beforeInput: false });
      release.resolve();
      yield* end;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-blocked-fence-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a newly blocked current frame cuts an already dispatched input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("blocked-gate-cut");
      const end = yield* activity.begin(threadId, "run");
      const control = new SessionControl("agent");
      const started = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      let cuts = 0;
      control.onDispatchCut(() => {
        cuts++;
      });
      const action = control.agent("agent", async () => {
        control.dispatchGate()();
        Deferred.doneUnsafe(started, Effect.void);
        await release.promise;
      });
      void action.catch(() => undefined);
      yield* Deferred.await(started);
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      const tab = {
        threadId,
        tabId: "tab",
        closing: false,
        control,
        page: { frames: () => [{ url: () => "https://blocked.test/" }] },
      };
      const refusal = yield* Effect.promise(() =>
        fence.assertTab(tab, "run").then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(refusal).toMatchObject({ reason: "blocked_url" });
      expect(cuts).toBe(1);
      const cut = yield* Effect.promise(() =>
        action.then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(cut).toMatchObject({ reason: "blocked_url", beforeInput: false });
      release.resolve();
      yield* end;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-gate-cut-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a synchronous frame check sees newly blocked hosts and fences the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("synchronous-fence");
      const end = yield* activity.begin(threadId, "run");
      const tab = {
        threadId,
        tabId: "tab",
        closing: false,
        page: { frames: () => [{ url: () => "https://blocked.test/" }] },
      };
      expect(fence.blockedFrame(tab, "run")).toBe(false);
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      expect(fence.blockedFrame(tab, "run")).toBe(true);
      expect(fence.isFenced(tab, "run")).toBe(true);
      yield* end;
      expect(fence.isFenced(tab, "run")).toBe(false);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-sync-fence-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a blocked check without an explicit run cuts the active run's observer signal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("implicit-run-cut");
      const end = yield* activity.begin(threadId, "run");
      const tab = {
        threadId,
        tabId: "tab",
        closing: false,
        page: { frames: () => [{ url: () => "https://safe.test/" }] },
      };
      const signal = fence.signal(tab, undefined);
      expect(signal?.aborted).toBe(false);
      const refusal = yield* Effect.promise(() =>
        fence.assertTab(tab, undefined, "https://blocked.test/").then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(refusal).toMatchObject({ reason: "blocked_url" });
      expect(signal?.aborted).toBe(true);
      yield* end;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-implicit-cut-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a popup run signal is cut when another run becomes current", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("popup-current-run");
      const endFirst = yield* activity.begin(threadId, "first");
      const first = fence.runSignal(threadId, "first");
      expect(fence.popupRun(threadId, undefined)).toBeUndefined();
      const popup = fence.popupRun(threadId, first);
      expect(popup?.signal.aborted).toBe(false);
      const endLater = yield* activity.begin(threadId, "later");
      expect(popup?.signal.aborted).toBe(true);
      expect(fence.popupRun(threadId, first)).toBeUndefined();
      popup?.release();
      yield* endLater;
      yield* endFirst;
      const endReused = yield* activity.begin(threadId, "first");
      expect(fence.popupRun(threadId, first)).toBeUndefined();
      yield* endReused;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-popup-run-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
