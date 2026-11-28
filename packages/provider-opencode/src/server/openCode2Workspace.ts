import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { followOpenCode2Scans, loadOpenCode2Workspace } from "./status.ts";
import type * as OpenCode2Server from "./v2/OpenCode2Server.ts";

export const makeOpenCode2WorkspaceTracker = Effect.fn(
  "OpenCodeDriver.makeOpenCode2WorkspaceTracker",
)(function* (input: {
  readonly server: OpenCode2Server.OpenCode2Server["Service"];
  readonly pathService: Path.Path;
  readonly currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>;
}) {
  // Locations whose scan GOAT saw end on the current server; a scan is announced only once.
  let scans = { url: "", scanned: new Set<string>() };
  // Skills that appear after a location's scan, such as a new SKILL.md or an MCP server's skills,
  // are announced by another skill.updated.
  const skillRescans = yield* Queue.unbounded<string, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.end(skillRescans));
  const skillUpdates = new Map<string, number>();
  // Locations GOAT has listed, by the cwd the registry asked for.
  const listed = new Map<string, string>();
  const driverScope = yield* Effect.scope;
  // A configured server keeps one connection, so a dropped event stream is resubscribed on read.
  let following: { readonly url: string; readonly subscribed: Deferred.Deferred<void> } | undefined;
  const followScans = Effect.fn("OpenCodeDriver.followScans")(function* (
    connection: OpenCode2Server.OpenCode2Connection,
  ) {
    if (following?.url === connection.url) return yield* Deferred.await(following.subscribed);
    const current = { url: connection.url, subscribed: yield* Deferred.make<void>() };
    following = current;
    const stopFollowing = Effect.sync(() => {
      if (following === current) following = undefined;
    }).pipe(Effect.andThen(Deferred.succeed(current.subscribed, undefined)));
    // Resubscribing to the same server keeps the scans it already announced.
    if (scans.url !== connection.url) scans = { url: connection.url, scanned: new Set() };
    const { scanned } = scans;
    const noteSkillUpdate = (event: {
      readonly type: string;
      readonly location?: { readonly directory?: string } | undefined;
    }) => {
      const directory = event.location?.directory;
      // The skill.updated that ends a scan is covered by the read that waits for that scan.
      if (
        event.type !== "skill.updated" ||
        directory === undefined ||
        !(scanned.has(directory) || listed.has(directory))
      ) {
        return Effect.void;
      }
      skillUpdates.set(directory, (skillUpdates.get(directory) ?? 0) + 1);
      const cwd = listed.get(directory);
      return cwd === undefined ? Effect.void : Queue.offer(skillRescans, cwd);
    };
    // Subscribe before the caller reads: OpenCode sends no events from before a subscription.
    const scope = yield* Scope.fork(driverScope);
    const release = stopFollowing.pipe(Effect.andThen(Scope.close(scope, Exit.void)));
    const events = yield* connection.events.pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.option,
      Effect.onInterrupt(() => release),
    );
    if (events._tag === "None") return yield* release;
    yield* Deferred.succeed(current.subscribed, undefined);
    yield* Effect.forkIn(
      followOpenCode2Scans(events.value.pipe(Stream.tap(noteSkillUpdate)), (directory) =>
        Effect.sync(() => scanned.add(directory)),
      ).pipe(Effect.ensuring(release)),
      driverScope,
    );
  });
  const listWorkspace = (cwd: string) =>
    input.server.withConnection((connection) =>
      Effect.gen(function* () {
        const { client, events, url } = connection;
        const [, stream] = yield* Effect.all(
          [followScans(connection), events.pipe(Effect.option)],
          {
            concurrency: "unbounded",
          },
        );
        // OpenCode names a location by its resolved path (no trailing slash or `..`).
        const directory = input.pathService.resolve(cwd);
        const location = { directory };
        if (scans.url !== url) scans = { url, scanned: new Set() };
        const { scanned: seen } = scans;
        const scanned = yield* Deferred.make<void>();
        if (stream._tag === "Some") {
          yield* followOpenCode2Scans(stream.value, (scannedDirectory) =>
            scannedDirectory === directory
              ? Deferred.succeed(scanned, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ).pipe(Effect.forkScoped);
        }
        const wasListed = listed.has(directory);
        let skillUpdatesBeforeRead = 0;
        const workspace = yield* loadOpenCode2Workspace(
          Effect.sync(() => {
            skillUpdatesBeforeRead = skillUpdates.get(directory) ?? 0;
          }).pipe(
            Effect.andThen(
              Effect.all(
                {
                  skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                  commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
                },
                { concurrency: "unbounded" },
              ),
            ),
          ),
          Deferred.await(scanned),
          // Without events no scan can be awaited, so trust the first read as before.
          stream._tag === "None" || seen.has(directory),
          yield* input.currentEnvironment,
        );
        // A location loaded before GOAT watched never announces its scan; wait for it only once.
        seen.add(directory);
        listed.set(directory, cwd);
        // The listener rescans a listed location itself; a first read may miss what it announced.
        if (!wasListed && (skillUpdates.get(directory) ?? 0) !== skillUpdatesBeforeRead) {
          yield* Queue.offer(skillRescans, cwd);
        }
        return workspace;
      }).pipe(Effect.scoped),
    );
  return {
    followScans,
    listWorkspace,
    skillRescans: Stream.fromQueue(skillRescans),
  };
});
