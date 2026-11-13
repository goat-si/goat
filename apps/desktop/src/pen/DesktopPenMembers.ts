import {
  DesktopPenMembersState,
  type DesktopPenMember,
  type DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import {
  penLeftMesh,
  penStateDir,
  watchPenSnapshots,
  type PenSnapshot,
  type PenWatchStale,
} from "@goat/pen-protocol/snapshot";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import { inspectPenExactAlias, type PenAliasUnreadable } from "@goat/ssh/penAlias";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { PEN_MEMBERS_CHANGED_CHANNEL } from "../ipc/channels.ts";

/** More members than this is treated as no list at all, never as a shortened one. */
export const PEN_MEMBER_CAP = 1024;
const REINSPECT_AFTER = "2 seconds";
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

type PenAliasInspection = Effect.Success<ReturnType<typeof inspectPenExactAlias>>;
type PublishedState = DesktopPenMembersState extends infer State
  ? State extends unknown
    ? Omit<State, "seq">
    : never
  : never;
type Membership =
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-member" }
  | {
      readonly kind: "ready";
      readonly selfNodeId: string;
      readonly selfName: string;
      readonly keys: ReadonlyMap<string, string>;
    };

export interface DesktopPenMembersDeps {
  /** Undefined when PEN_HOME is set to a path Pen itself would not use. */
  readonly stateDir: string | undefined;
  readonly stateDirExists: (stateDir: string) => Effect.Effect<boolean>;
  readonly leftMesh: (stateDir: string) => Effect.Effect<boolean>;
  readonly watch: (input: {
    readonly stateDir: string;
    readonly onSnapshot: (snapshot: PenSnapshot) => void;
    readonly onStale: (reason: PenWatchStale) => void;
  }) => () => void;
  readonly inspect: (alias: string) => Effect.Effect<PenAliasInspection, PenAliasUnreadable>;
  readonly publish: (state: DesktopPenMembersState) => Effect.Effect<void>;
}

export interface TrustedPenSelf {
  readonly selfNodeId: string;
  readonly selfName: string;
}

export interface DesktopPenMembersShape {
  readonly state: Effect.Effect<DesktopPenMembersState>;
  /**
   * Fails unless ssh, as configured now, reaches exactly that member over this target's alias.
   * `requireReady` is for a new credential: it also needs a live member list naming the member.
   */
  readonly requireTrusted: (
    target: DesktopSshEnvironmentTarget,
    nodeId: string,
    options: { readonly requireReady: boolean },
  ) => Effect.Effect<TrustedPenSelf | undefined, SshInvalidTargetError>;
}

/** Without the layer nothing is a Pen member: every managed route is refused. */
export class DesktopPenMembers extends Context.Reference<DesktopPenMembersShape>(
  "@goat/desktop/pen/DesktopPenMembers",
  {
    defaultValue: () => ({
      state: Effect.succeed({ kind: "unavailable", seq: 0, reason: "no-pen" }),
      requireTrusted: () =>
        Effect.fail(new SshInvalidTargetError({ message: "Pen machines are not available here." })),
    }),
  },
) {}

const settles = (reason: string) => reason === "not-in-pen-config" || reason === "no-recorded-key";
const sameState = Schema.toEquivalence(DesktopPenMembersState);

export const make = Effect.fn("DesktopPenMembers.make")(function* (deps: DesktopPenMembersDeps) {
  let current: DesktopPenMembersState = { kind: "unavailable", seq: 0, reason: "stale" };
  // Read at each use: a member removed by a snapshot is refused before its routes are inspected.
  let membership: Membership = { kind: "unavailable" };

  const set = (next: PublishedState) =>
    Effect.suspend(() => {
      if (sameState({ ...next, seq: current.seq } as DesktopPenMembersState, current))
        return Effect.void;
      current = { ...next, seq: current.seq + 1 } as DesktopPenMembersState;
      return deps.publish(current);
    });

  const inspectMember = (member: PenSnapshot["members"][number]) =>
    deps.inspect(`pen-${member.nodeId}`).pipe(
      Effect.map((result): DesktopPenMember["route"] =>
        "refused" in result
          ? { kind: "refused", reason: result.refused }
          : result.nodeId === member.nodeId && result.noisePub === member.noisePub
            ? { kind: "trusted", target: result.target, revision: result.revision }
            : { kind: "refused", reason: "key-mismatch" },
      ),
      Effect.catchTags({
        PenAliasUnreadable: () =>
          Effect.succeed<DesktopPenMember["route"]>({ kind: "refused", reason: "unreadable" }),
      }),
      Effect.map((route): DesktopPenMember => ({
        nodeId: member.nodeId as DesktopPenMember["nodeId"],
        name: member.name,
        online: member.online,
        noisePub: member.noisePub,
        route,
      })),
    );

  const remember = (snapshot: PenSnapshot) => {
    const self = snapshot.members.find((member) => member.nodeId === snapshot.self);
    membership =
      self === undefined
        ? { kind: "not-member" }
        : snapshot.members.length - 1 > PEN_MEMBER_CAP
          ? { kind: "unavailable" }
          : {
              kind: "ready",
              selfNodeId: snapshot.self,
              selfName: self.name,
              keys: new Map(snapshot.members.map((member) => [member.nodeId, member.noisePub])),
            };
  };

  const session = Effect.fn("DesktopPenMembers.session")(function* (stateDir: string) {
    const wake = yield* Queue.sliding<void>(1);
    let latest: { readonly snapshot: PenSnapshot } | { readonly stale: PenWatchStale } | undefined;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        deps.watch({
          stateDir,
          onSnapshot: (snapshot) => {
            if (latest !== undefined && "stale" in latest) return;
            latest = { snapshot };
            remember(snapshot);
            Queue.offerUnsafe(wake, undefined);
          },
          onStale: (stale) => {
            latest = { stale };
            membership = { kind: "unavailable" };
            Queue.offerUnsafe(wake, undefined);
          },
        }),
      ),
      (stop) => Effect.sync(stop),
    );
    let sawSnapshot = false;
    while (true) {
      yield* Queue.take(wake);
      const event = latest;
      if (event === undefined) continue;
      if ("stale" in event) {
        if (yield* deps.leftMesh(stateDir)) {
          membership = { kind: "not-member" };
          yield* set({ kind: "not-member" });
        } else {
          yield* set({
            kind: "unavailable",
            reason: event.stale === "connect" ? "daemon-down" : "stale",
          });
        }
        return sawSnapshot;
      }
      sawSnapshot = true;
      const { snapshot } = event;
      const isCurrent = () => latest === event;
      if (membership.kind !== "ready") {
        yield* set(
          membership.kind === "not-member"
            ? { kind: "not-member" }
            : { kind: "unavailable", reason: "stale" },
        );
        continue;
      }
      const inspectAll = Effect.forEach(
        snapshot.members.filter((member) => member.nodeId !== snapshot.self),
        inspectMember,
      );
      const ready = (members: ReadonlyArray<DesktopPenMember>): PublishedState => ({
        kind: "ready",
        meshId: snapshot.mesh as DesktopPenMember["nodeId"],
        selfNodeId: snapshot.self as DesktopPenMember["nodeId"],
        members,
      });
      const members = yield* inspectAll;
      if (!isCurrent()) continue;
      yield* set(ready(members));
      // Pen rewrites its ssh config after it publishes a snapshot, so a new member settles late.
      if (
        members.some((member) => member.route.kind === "refused" && settles(member.route.reason))
      ) {
        const superseded = yield* Effect.race(
          Effect.as(Effect.sleep(REINSPECT_AFTER), false),
          Effect.as(Queue.take(wake), true),
        );
        if (superseded) {
          Queue.offerUnsafe(wake, undefined);
          continue;
        }
        const settled = yield* inspectAll;
        if (isCurrent()) yield* set(ready(settled));
      }
    }
  }, Effect.scoped);

  let failures = 0;
  const attempt = Effect.gen(function* () {
    const stateDir = deps.stateDir;
    if (stateDir === undefined || !(yield* deps.stateDirExists(stateDir))) {
      membership = { kind: "unavailable" };
      yield* set({ kind: "unavailable", reason: "no-pen" });
    } else if (
      yield* session(stateDir).pipe(
        // One bad pass must not end the watch for the life of the app.
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop.pen.members.watch.failed", cause).pipe(Effect.as(false)),
        ),
      )
    ) {
      failures = 0;
    }
    yield* Effect.sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures));
    failures = Math.min(failures + 1, 6);
  });
  yield* Effect.forever(attempt).pipe(Effect.forkScoped);

  const refuse = (message: string) => new SshInvalidTargetError({ message });
  const requireTrusted = Effect.fn("DesktopPenMembers.requireTrusted")(function* (
    target: DesktopSshEnvironmentTarget,
    nodeId: string,
    options: { readonly requireReady: boolean },
  ) {
    const alias = `pen-${nodeId}`;
    if (target.alias !== alias || target.hostname !== alias)
      return yield* refuse("A Pen machine is reached only through its own Pen alias.");
    const route = yield* deps.inspect(alias).pipe(
      Effect.catchTags({
        PenAliasUnreadable: () => Effect.succeed({ refused: "unreadable" as const }),
      }),
    );
    if ("refused" in route)
      return yield* refuse(`Pen does not vouch for ${alias} on this machine (${route.refused}).`);
    if (route.nodeId !== nodeId)
      return yield* refuse(`${alias} does not lead to that Pen machine.`);
    const view = membership;
    if (view.kind === "ready") {
      if (view.keys.get(nodeId) !== route.noisePub || nodeId === view.selfNodeId)
        return yield* refuse("That machine is no longer a Pen member with this key.");
      return { selfNodeId: view.selfNodeId, selfName: view.selfName };
    }
    if (view.kind === "not-member")
      return yield* refuse("This machine is no longer in the Pen mesh.");
    if (options.requireReady)
      return yield* refuse("Pen is not running here, so its member list cannot be confirmed.");
    return undefined;
  });

  return { state: Effect.sync(() => current), requireTrusted } satisfies DesktopPenMembersShape;
});

export const layer = Layer.effect(
  DesktopPenMembers,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const fs = yield* FileSystem.FileSystem;
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    return yield* make({
      stateDir: penStateDir(process.env, environment.homeDirectory),
      stateDirExists: (stateDir) => fs.exists(stateDir).pipe(Effect.orElseSucceed(() => false)),
      leftMesh: (stateDir) => Effect.promise(() => penLeftMesh(stateDir)),
      watch: watchPenSnapshots,
      inspect: (alias) =>
        inspectPenExactAlias({ alias, homeDirectory: environment.homeDirectory }).pipe(
          Effect.provide(services),
        ),
      publish: (state) => electronWindow.sendAll(PEN_MEMBERS_CHANGED_CHANNEL, state),
    });
  }),
);
