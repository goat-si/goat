import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { followOpenCode2Scans, loadOpenCode2Workspace } from "./status.ts";
import type * as OpenCode2Server from "./v2/OpenCode2Server.ts";

export const makeOpenCode2WorkspaceTracker = (input: {
  readonly server: OpenCode2Server.OpenCode2Server["Service"];
  readonly pathService: Path.Path;
  readonly currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>;
  readonly scope: Scope.Scope;
}) => {
  // Locations whose scan GOAT saw end on the current server; a scan is announced only once.
  let scans = { url: "", scanned: new Set<string>() };
  const followScans = (connection: OpenCode2Server.OpenCode2Connection) =>
    Effect.suspend(() => {
      const scanned = new Set<string>();
      scans = { url: connection.url, scanned };
      return connection.events.pipe(
        Effect.flatMap((events) =>
          followOpenCode2Scans(events, (directory) => Effect.sync(() => scanned.add(directory))),
        ),
        Effect.scoped,
        Effect.ignore,
        Effect.forkIn(input.scope),
      );
    });
  const listWorkspace = (cwd: string) =>
    input.server.withConnection(({ client, events, url }) =>
      Effect.gen(function* () {
        // OpenCode names a location by its resolved path (no trailing slash or `..`).
        const directory = input.pathService.resolve(cwd);
        const location = { directory };
        if (scans.url !== url) scans = { url, scanned: new Set() };
        const { scanned: seen } = scans;
        const scanned = yield* Deferred.make<void>();
        const stream = yield* events.pipe(Effect.option);
        if (stream._tag === "Some") {
          yield* followOpenCode2Scans(stream.value, (scannedDirectory) =>
            scannedDirectory === directory
              ? Deferred.succeed(scanned, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ).pipe(Effect.forkScoped);
        }
        const workspace = yield* loadOpenCode2Workspace(
          Effect.all(
            {
              skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
              commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
            },
            { concurrency: "unbounded" },
          ),
          Deferred.await(scanned),
          // Without events no scan can be awaited, so trust the first read as before.
          stream._tag === "None" || seen.has(directory),
          yield* input.currentEnvironment,
        );
        // A location loaded before GOAT watched never announces its scan; wait for it only once.
        seen.add(directory);
        return workspace;
      }).pipe(Effect.scoped),
    );
  return { followScans, listWorkspace };
};
