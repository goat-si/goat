import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { loadOpenCode2Workspace } from "./status.ts";
import type * as OpenCode2Server from "./v2/OpenCode2Server.ts";

export const makeOpenCode2WorkspaceLister =
  (input: {
    readonly server: OpenCode2Server.OpenCode2Server["Service"];
    readonly pathService: Path.Path;
    readonly currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>;
  }) =>
  (cwd: string) =>
    input.server.withConnection(({ client, events }) =>
      Effect.gen(function* () {
        // OpenCode names a location by its resolved path (no trailing slash or `..`).
        const directory = input.pathService.resolve(cwd);
        const location = { directory };
        const scanned = yield* Deferred.make<void>();
        const pending = new Set(["command.updated", "skill.updated"]);
        const stream = yield* events.pipe(Effect.option);
        if (stream._tag === "Some") {
          yield* stream.value.pipe(
            Stream.runForEach((event) =>
              "location" in event &&
              event.location?.directory === directory &&
              pending.delete(event.type) &&
              pending.size === 0
                ? Deferred.succeed(scanned, undefined)
                : Effect.void,
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
        }
        return yield* loadOpenCode2Workspace(
          Effect.all(
            {
              skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
              commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
            },
            { concurrency: "unbounded" },
          ),
          Deferred.await(scanned),
          // Without events no scan can be awaited, so trust the first read as before.
          stream._tag === "None"
            ? Effect.succeed(true)
            : client.debug.location.list().pipe(
                Effect.map((loaded) => loaded.some((entry) => entry.directory === directory)),
                Effect.timeout("2 seconds"),
                Effect.orElseSucceed(() => true),
              ),
          // OpenCode answers provider.list for a location only once its skill scan has ended.
          client.provider.list({ location }).pipe(Effect.timeout("10 seconds"), Effect.ignore),
          yield* input.currentEnvironment,
        );
      }).pipe(Effect.scoped),
    );
