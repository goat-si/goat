import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { database, fixture, origin } from "./RemoteDispatchCoordinator.testkit.ts";

it.effect(
  "regression F13-1: a refusal that may have started is never relaunched without report",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.launchError(
        new Ssh.SshRemoteDispatchError({
          reason: "remote_refused",
          message:
            'On box, GOAT there says: "goat_thread_launch does not take report, so nothing ran."',
          launchMayHaveStarted: true,
        }),
      );
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        assert.equal((yield* f.launch(c).pipe(Effect.result))._tag, "Failure");
        assert.equal(f.launchAttempts(), 1);
        assert.equal((yield* c.listForOrigin(origin))[0]?.state, "lost");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);
