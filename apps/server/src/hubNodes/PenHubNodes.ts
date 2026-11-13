import * as HostProcess from "@goat/shared/HostProcess";
import { inspectPenExactAlias, type PenAliasUnreadable } from "@goat/ssh/penAlias";
import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PenMembershipWatch } from "../pen/PenMembershipWatch.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HubNodes } from "./HubNodes.ts";
import type { PenRouteBinding } from "./PenManagedRoutes.ts";

type PenAliasInspection = Effect.Success<ReturnType<typeof inspectPenExactAlias>>;
const CHECK_TIMEOUT = "60 seconds";
const RETRY_DELAYS = ["5 seconds", "30 seconds", "2 minutes", "10 minutes"] as const;

/**
 * Keeps one hub registration per trusted Pen member, on a server that is itself a member and has
 * `penHubNodes` on. The member list only proposes: a member is registered when ssh's exact alias
 * pins the same node id and key, and every later use is admitted again by PenManagedRoutes.
 * Nothing here installs GOAT anywhere or grants a client anything.
 */
export const make = Effect.fn("PenHubNodes.make")(function* (input: {
  readonly inspect: (alias: string) => Effect.Effect<PenAliasInspection, PenAliasUnreadable>;
}) {
  const nodes = yield* HubNodes;
  const settings = yield* ServerSettingsService;
  // Bumped by every trigger, so work begun for an older member list or setting writes nothing.
  let revision = 0;

  const trusted = Effect.fn("PenHubNodes.trusted")(function* (
    view: Extract<PenMembershipView, { kind: "ready" }>,
    isCurrent: () => boolean,
  ) {
    const members: Array<PenRouteBinding & { readonly name: string; readonly online: boolean }> =
      [];
    for (const member of view.snapshot.members) {
      if (member.nodeId === view.snapshot.self) continue;
      if (!isCurrent()) return undefined;
      const route = yield* input.inspect(`pen-${member.nodeId}`).pipe(
        Effect.catchTags({
          PenAliasUnreadable: () => Effect.succeed({ refused: "unreadable" as const }),
        }),
      );
      if ("refused" in route) continue;
      if (route.nodeId !== member.nodeId || route.noisePub !== member.noisePub) continue;
      members.push({
        meshId: view.snapshot.mesh,
        nodeId: member.nodeId,
        noisePub: member.noisePub,
        name: member.name,
        online: member.online,
      });
    }
    return members;
  });

  const pass = Effect.fn("PenHubNodes.pass")(function* (view: PenMembershipView) {
    const mine = ++revision;
    const isCurrent = () => revision === mine;
    const stored = yield* settings.getSettings.pipe(Effect.option);
    // Unreadable settings or a Pen that is down say nothing about who left: change nothing.
    if (stored._tag === "None" || view.kind === "unavailable") return;
    for (const delay of [undefined, ...RETRY_DELAYS]) {
      if (delay !== undefined) yield* Effect.sleep(delay);
      const members =
        stored.value.penHubNodes && view.kind === "ready" ? yield* trusted(view, isCurrent) : [];
      if (members === undefined || !isCurrent()) return;
      const result = yield* nodes.reconcilePen({ members, isCurrent });
      // A new registration learns which machine it is by reading, never by preparing a runtime.
      for (const routeId of result.added) {
        if (!isCurrent()) return;
        if (members.some((member) => member.online && `ssh:pen-${member.nodeId}` === routeId))
          yield* nodes
            .check({ nodeId: `route:${routeId}` })
            .pipe(Effect.timeout(CHECK_TIMEOUT), Effect.ignore);
      }
      if (!result.retry) return;
    }
  });

  return { pass };
});

const follow = Effect.fn("PenHubNodes.follow")(function* (input: Parameters<typeof make>[0]) {
  const settings = yield* ServerSettingsService;
  const watch = yield* PenMembershipWatch;
  // Subscribed before the first read, so a setting changed during startup is not missed.
  const settingChanges = yield* settings.subscribeChanges;
  const { pass } = yield* make(input);
  yield* Stream.merge(
    watch.changes,
    settingChanges.pipe(
      Stream.map((value) => value.penHubNodes),
      Stream.changes,
      Stream.mapEffect(() => watch.current),
    ),
  ).pipe(
    Stream.switchMap((view) =>
      Stream.fromEffect(
        pass(view).pipe(
          // One failed pass must not end reconciliation for the life of the server.
          Effect.catchCause((cause) => Effect.logWarning("pen.hubNodes.pass.failed", cause)),
        ),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    yield* follow({
      inspect: (alias) =>
        inspectPenExactAlias({ alias, homeDirectory }).pipe(Effect.provide(services)),
    });
  }),
);
