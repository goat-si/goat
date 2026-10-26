import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  launcher,
  target,
  run1,
  makeWorld,
  withService,
  tempDir,
  watchRemote,
} from "./LaunchWatchService.testkit.ts";

it.effect("legacy watch remains registered when its recorded alternate is offline", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const started = yield* Deferred.make<void>();
    world.hostCall = () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          Effect.fail(
            new SshRemoteDispatch.SshRemoteDispatchError({
              reason: "host_unavailable",
              message: "recorded alternate is offline",
            }),
          ),
        ),
      );
    const baseDir = yield* tempDir;
    yield* withService(world, baseDir, (service) =>
      Effect.gen(function* () {
        yield* watchRemote(service, run1);
        yield* Deferred.await(started);
        const saved = yield* service.find({
          launcherThreadId: launcher,
          host: "box",
          threadId: target,
        });
        expect(saved?.pendingRuns).toEqual([run1]);
        expect(world.deliveredLog).toHaveLength(0);
      }),
    );
  }),
);
