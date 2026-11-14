import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import type { OpenCodeServerLaunch } from "../OpenCodeServerOwner.ts";
import type * as OpenCode2Server from "./OpenCode2Server.ts";

export const borrowConnection = Effect.fn("OpenCode2Adapter.borrowConnection")(function* (
  server: OpenCode2Server.OpenCode2Server["Service"],
  launch?: OpenCodeServerLaunch,
) {
  const lent = yield* Deferred.make<
    OpenCode2Server.OpenCode2Connection,
    OpenCodeRuntime.OpenCodeRuntimeError
  >();
  yield* server
    .withConnection(
      (connection) => Deferred.succeed(lent, connection).pipe(Effect.andThen(Effect.never)),
      launch,
    )
    .pipe(
      Effect.catch((error) => Deferred.fail(lent, error)),
      Effect.forkScoped,
    );
  return yield* Deferred.await(lent);
});
