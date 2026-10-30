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
        page: { url: () => "https://safe.example/" },
      };
      const end = yield* activity.begin(threadId, "run");
      const observation = fence.observe(tab, "https://example.com/");
      expect(observation).toBeDefined();
      yield* Deferred.await(entered);
      yield* end;
      const endNext = yield* activity.begin(threadId, "run");
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => observation!);
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
        page: { url: () => "https://safe.example/" },
      };
      yield* Effect.promise(() => fence.observe(tab, "https://example.com/")!);
      expect(cuts).toBe(1);
      const result = yield* Effect.tryPromise({ try: () => action, catch: (error) => error }).pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", beforeInput: false });
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
