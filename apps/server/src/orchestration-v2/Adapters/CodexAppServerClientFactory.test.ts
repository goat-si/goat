import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import { CodexDetachedAppServers } from "../../provider/CodexDetachedAppServerLive.ts";
import {
  CodexAppServerClientFactory,
  layerAppServerClientFactory,
} from "./CodexAppServerClientFactory.ts";

const defaultSettings = Schema.decodeSync(CodexSettings)({});

it.effect("a socket attempt that leaves an unstoppable process refuses the stdio fallback", () =>
  Effect.gen(function* () {
    let blockChecks = 0;
    let spawned = false;
    const layer = layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CodexDetachedAppServers)({
            socketTransportEnabled: true,
            open: () => Effect.fail(new CodexDetachedAppServerError({ detail: "not ready" })),
            ensureNotBlocked: () =>
              Effect.suspend(() =>
                ++blockChecks === 1
                  ? Effect.void
                  : Effect.fail(new CodexDetachedAppServerError({ detail: "still running" })),
              ),
          }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () =>
              Effect.sync(() => {
                spawned = true;
              }).pipe(Effect.andThen(Effect.die("stdio must not spawn"))),
          }),
          Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
            native: undefined,
            canonical: undefined,
          }),
        ),
      ),
    );
    const error = yield* Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      return yield* factory
        .open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("session-1"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          settings: defaultSettings,
          environment: {},
        })
        .pipe(Effect.scoped, Effect.flip);
    }).pipe(Effect.provide(layer));
    assert.equal(error._tag, "ProviderAdapterOpenSessionError");
    assert.equal(blockChecks, 2);
    assert.isFalse(spawned);
  }),
);
