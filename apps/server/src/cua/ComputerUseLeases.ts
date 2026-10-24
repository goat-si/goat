/**
 * ComputerUseLeases - who may use this host's screen, and the control each thread holds now.
 *
 * An unattended thread's admission is its approved computer_use.grant handoff: the lease is
 * active while that handoff is completed and before its expiry, so the event log is the only
 * record and a restart neither loses nor extends one. Ending early moves the handoff to
 * cancelled. Changes are signalled so lease proxies stop without waiting for their next call.
 * A grant that lists apps admits only those apps, for interactive threads too.
 *
 * Every attached driver, interactive or not, runs behind the proxy under a control: an id the
 * server mints for one thread's stretch of use. Stop, the host kill switch and expiry end the
 * control and kill its transport; the next turn mints a new id, so adapters respawn the proxy.
 * Controls and the host pause live in memory: a restart ends them, like the providers they serve.
 *
 * @module ComputerUseLeases
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type ComputerUseControlEnd,
  type ComputerUsePauseReason,
  Handoff,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- control ids are minted inside a sync map update.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveSelfInvocation, type SelfInvocation } from "@goat/shared/nodeRuntime";

import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export class ComputerUseLeaseError extends Schema.TaggedError<ComputerUseLeaseError>()(
  "ComputerUseLeaseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read computer use admissions.";
  }
}

export interface ComputerUseLease {
  readonly threadId: ThreadId;
  readonly handoffId: TurnItemId;
  readonly expiresAt: DateTime.Utc;
  /** Absent when the grant admits every app. */
  readonly apps?: ReadonlyArray<string>;
}

/** Whether the host's helper reports a person's input and secret fields at all. */
export interface ComputerUseDetection {
  readonly humanInput: boolean;
  readonly privateMode: boolean;
}

/** One thread's current stretch of computer use, what its proxy was started with. */
export interface ComputerUseControl {
  readonly controlId: string;
  readonly threadId: ThreadId;
  readonly expiresAt: DateTime.Utc;
  /** The grant an unattended control lives on; interactive controls have none. */
  readonly handoffId?: TurnItemId;
}

export type ComputerUseControlState =
  | {
      readonly _tag: "active";
      readonly expiresAt: DateTime.Utc;
      /** Host pauses so far, so a proxy that missed one still ends the call it overlapped. */
      readonly interruptions: Interruptions;
      /** Absent when every app the driver admits is allowed. */
      readonly apps: ReadonlyArray<string> | undefined;
      /** When this state can next change without a signal, epoch ms. */
      readonly wakeAt: number;
    }
  | { readonly _tag: "paused"; readonly reason: ComputerUsePauseReason }
  | { readonly _tag: "ended"; readonly reason: ComputerUseControlEnd };

export interface Interruptions {
  readonly count: number;
  readonly last: ComputerUsePauseReason;
}

/** How long an interactive control lasts before the thread's next turn mints another. */
const INTERACTIVE_CONTROL_MINUTES = 60;
const WATCH_RETRY_MS = 1_000;

/** Why a thread runs without a person directing it; see ComputerUseOrigin. */
export type ChannelOrigin = "goat_bot" | "channel_task";

export type ComputerUseLeaseState =
  | { readonly _tag: "active"; readonly lease: ComputerUseLease }
  | { readonly _tag: "ended"; readonly reason: "expired" | "revoked" };

export class ComputerUseLeases extends Context.Service<
  ComputerUseLeases,
  {
    /** The thread's live admission, if any. */
    readonly active: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ComputerUseLease>, ComputerUseLeaseError>;
    /** The live admission on this host held by a thread other than `except`. */
    readonly holder: (
      except?: ThreadId,
    ) => Effect.Effect<Option.Option<ComputerUseLease>, ComputerUseLeaseError>;
    /** Whether the thread is the GOAT Bot thread. Channel workers are known by their id. */
    readonly channelOrigin: (
      threadId: ThreadId,
    ) => Effect.Effect<ChannelOrigin | undefined, ComputerUseLeaseError>;
    /** Where one admission stands, for the proxy started with it. */
    readonly state: (
      threadId: ThreadId,
      handoffId: string,
    ) => Effect.Effect<ComputerUseLeaseState, ComputerUseLeaseError>;
    /** The thread's live control, minted when it has none or its grant changed. */
    readonly control: (
      threadId: ThreadId,
      lease: Option.Option<ComputerUseLease>,
    ) => Effect.Effect<ComputerUseControl>;
    /** Where one control stands, for the proxy started with it. */
    readonly controlState: (
      threadId: ThreadId,
      controlId: string,
    ) => Effect.Effect<ComputerUseControlState, ComputerUseLeaseError>;
    /** Ends the thread's control; true when one was live. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Ends every control on this host, returning the threads that held one. */
    readonly stopAll: Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Every live grant on this host, for the kill switch to end. */
    readonly grants: Effect.Effect<ReadonlyArray<ComputerUseLease>, ComputerUseLeaseError>;
    /** Which safety reports this host's helper sends; unattended turns need both. */
    readonly detection: Effect.Effect<ComputerUseDetection>;
    /** Holds every control on this host until resume. */
    readonly pause: (reason: ComputerUsePauseReason) => Effect.Effect<void>;
    readonly resume: Effect.Effect<void>;
    /** Wakes after any admission may have started or ended. Subscribe before reading. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly changed: Effect.Effect<void>;
    /** How this server starts its own lease proxy subcommand. */
    readonly proxy: SelfInvocation | undefined;
  }
>()("goat/cua/ComputerUseLeases") {}

const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);

/** A completed grant before its expiry. A grant without an expiry is never live. */
const leaseOf = (handoff: Handoff, now: DateTime.Utc): Option.Option<ComputerUseLease> =>
  handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
  handoff.state === "completed" &&
  handoff.expiresAt !== null &&
  DateTime.toEpochMillis(handoff.expiresAt) > DateTime.toEpochMillis(now)
    ? Option.some({
        threadId: handoff.requestedBy.threadId,
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
        ...(handoff.apps === undefined ? {} : { apps: handoff.apps }),
      })
    : Option.none();

/** The apps a thread's live grants admit together; absent when one of them admits every app. */
const appsOf = (leases: ReadonlyArray<ComputerUseLease>): ReadonlyArray<string> | undefined => {
  const apps = new Set<string>();
  for (const lease of leases) {
    if (lease.apps === undefined) return undefined;
    for (const app of lease.apps) apps.add(app);
  }
  return [...apps].sort();
};

interface ControlRecord extends ComputerUseControl {
  readonly ended?: ComputerUseControlEnd;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* ChannelBotDirectory.ChannelBotDirectory;
  const signals = yield* PubSub.sliding<void>(16);
  // Wakes the desktop watch below; a new control does not wake proxies, so it has its own.
  const watchKick = yield* PubSub.sliding<void>(1);
  const kick = PubSub.publish(watchKick, undefined).pipe(Effect.asVoid);
  const proxy = Option.getOrUndefined(yield* resolveSelfInvocation().pipe(Effect.option));
  const controls = new Map<ThreadId, ControlRecord>();
  let paused: ComputerUsePauseReason | undefined;
  const changed = PubSub.publish(signals, undefined).pipe(Effect.andThen(kick));

  const live = Effect.fn("ComputerUseLeases.live")(function* (threadId?: ThreadId) {
    const rows = yield* sql<{ handoff_json: string | null }>`
      SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items
      WHERE type = 'human_handoff' AND status = 'completed'
        AND json_extract(payload_json, '$.handoff.target.path') = ${COMPUTER_USE_GRANT_HANDOFF_PATH}
        ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`}
    `.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
    const now = yield* DateTime.now;
    const leases: Array<ComputerUseLease> = [];
    for (const row of rows) {
      if (row.handoff_json === null) continue;
      const handoff = yield* decodeHandoff(row.handoff_json).pipe(
        Effect.mapError((cause) => new ComputerUseLeaseError({ cause })),
      );
      const lease = leaseOf(handoff, now);
      if (Option.isSome(lease)) leases.push(lease.value);
    }
    return [...leases].sort(
      (a, b) => DateTime.toEpochMillis(b.expiresAt) - DateTime.toEpochMillis(a.expiresAt),
    );
  });

  const state = Effect.fn("ComputerUseLeases.state")(function* (
    threadId: ThreadId,
    handoffId: string,
  ) {
    const rows = yield* sql<{ handoff_json: string | null }>`
      SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND turn_item_id = ${handoffId} AND type = 'human_handoff'
    `.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
    const json = rows[0]?.handoff_json;
    if (json == null) return { _tag: "ended", reason: "revoked" } as const;
    const handoff = yield* decodeHandoff(json).pipe(
      Effect.mapError((cause) => new ComputerUseLeaseError({ cause })),
    );
    const lease = leaseOf(handoff, yield* DateTime.now);
    if (Option.isSome(lease)) return { _tag: "active", lease: lease.value } as const;
    return {
      _tag: "ended",
      reason: handoff.state === "completed" || handoff.state === "expired" ? "expired" : "revoked",
    } as const;
  });

  const control = Effect.fn("ComputerUseLeases.control")(function* (
    threadId: ThreadId,
    lease: Option.Option<ComputerUseLease>,
  ) {
    const now = yield* DateTime.now;
    const handoffId = Option.isSome(lease) ? lease.value.handoffId : undefined;
    const existing = controls.get(threadId);
    if (
      existing !== undefined &&
      existing.ended === undefined &&
      existing.handoffId === handoffId &&
      DateTime.toEpochMillis(existing.expiresAt) > DateTime.toEpochMillis(now)
    )
      return existing as ComputerUseControl;
    const next: ControlRecord = {
      controlId: `control:${NodeCrypto.randomUUID()}`,
      threadId,
      expiresAt: Option.isSome(lease)
        ? lease.value.expiresAt
        : DateTime.add(now, { minutes: INTERACTIVE_CONTROL_MINUTES }),
      ...(handoffId === undefined ? {} : { handoffId }),
    };
    controls.set(threadId, next);
    yield* kick;
    // A proxy still holding the previous id hears it was replaced.
    if (existing !== undefined && existing.ended === undefined) yield* changed;
    return next as ComputerUseControl;
  });

  let interruptions: Interruptions = { count: 0, last: "human_input" };
  const interrupted = (last: ComputerUsePauseReason) => {
    interruptions = { count: interruptions.count + 1, last };
  };

  const controlState = Effect.fn("ComputerUseLeases.controlState")(function* (
    threadId: ThreadId,
    controlId: string,
  ): Effect.fn.Return<ComputerUseControlState, ComputerUseLeaseError> {
    const record = controls.get(threadId);
    if (record === undefined) return { _tag: "ended", reason: "revoked" };
    if (record.controlId !== controlId) return { _tag: "ended", reason: "replaced" };
    if (record.ended !== undefined) return { _tag: "ended", reason: record.ended };
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now))
      return { _tag: "ended", reason: "expired" };
    // A secret on screen outranks every other pause and lifts by itself when it loses focus.
    if (privateHost) return { _tag: "paused", reason: "private" };
    if (paused !== undefined) return { _tag: "paused", reason: paused };
    if (record.handoffId !== undefined) {
      const grant = yield* state(threadId, record.handoffId);
      if (grant._tag === "ended") return grant;
      return {
        _tag: "active",
        expiresAt: record.expiresAt,
        interruptions,
        apps: grant.lease.apps,
        wakeAt: DateTime.toEpochMillis(record.expiresAt),
      };
    }
    // An interactive thread controls the apps its grants name, and only the safe reads without one.
    const grants = yield* live(threadId);
    return {
      _tag: "active",
      expiresAt: record.expiresAt,
      interruptions,
      apps: grants.length === 0 ? [] : appsOf(grants),
      wakeAt: Math.min(
        DateTime.toEpochMillis(record.expiresAt),
        ...grants.map((grant) => DateTime.toEpochMillis(grant.expiresAt)),
      ),
    };
  });

  const end = (threadId: ThreadId, reason: ComputerUseControlEnd) => {
    const record = controls.get(threadId);
    if (record === undefined || record.ended !== undefined) return false;
    controls.set(threadId, { ...record, ended: reason });
    // A pause belongs to the agents it held; with none left the next one starts unpaused.
    if (![...controls.values()].some((other) => other.ended === undefined)) paused = undefined;
    return true;
  };

  const pause = (reason: ComputerUsePauseReason) =>
    Effect.sync(() => {
      // A person's input with no agent on the screen is just a person using their computer.
      if (![...controls.values()].some((record) => record.ended === undefined)) return false;
      paused = reason;
      interrupted(reason);
      return true;
    }).pipe(Effect.flatMap((held) => (held ? changed : Effect.void)));

  // The desktop host's helper reports a person's own input and secret fields, and says which it
  // can detect at all; a standalone server and an older helper report nothing (#1235).
  let detection: ComputerUseDetection = { humanInput: false, privateMode: false };
  let privateHost = false;
  const desktop = yield* Effect.serviceOption(DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  if (Option.isSome(desktop))
    yield* desktop.value.cuaSafety.pipe(
      Stream.runForEach((report) => {
        if (report.type === "cuaHumanInput") return pause("human_input");
        if (report.type === "cuaDetection")
          return Effect.sync(() => {
            detection = { humanInput: report.humanInput, privateMode: report.privateMode };
          }).pipe(Effect.andThen(changed));
        return Effect.sync(() => {
          if (report.active && !privateHost) interrupted("private");
          privateHost = report.active;
        }).pipe(Effect.andThen(changed));
      }),
      Effect.forkScoped,
    );

  // The desktop's helper watches for secret fields and a person's input only while an agent
  // controls this host (D7): from the first live control until the last one ends or expires.
  if (Option.isSome(desktop)) {
    const kicks = yield* PubSub.subscribe(watchKick);
    const receiver = desktop.value;
    yield* Effect.gen(function* () {
      // What the desktop last heard; it starts out not watching. After a failed write it may
      // have heard either value, so the current one goes out until a write succeeds.
      let delivered = false;
      let unsure = false;
      for (;;) {
        // A grant cancelled or expired under a control ends it, though nothing here ended it.
        let endedAny = false;
        for (const record of [...controls.values()]) {
          if (record.ended !== undefined || record.handoffId === undefined) continue;
          const grant = yield* state(record.threadId, record.handoffId).pipe(Effect.option);
          // The lookup yields: a newer control for the thread is not judged by this grant.
          if (
            Option.isSome(grant) &&
            grant.value._tag === "ended" &&
            controls.get(record.threadId)?.controlId === record.controlId
          )
            endedAny = end(record.threadId, grant.value.reason) || endedAny;
        }
        // Proxies waiting on a pause hear their control ended.
        if (endedAny) yield* PubSub.publish(signals, undefined);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const expiries = [...controls.values()]
          .filter((record) => record.ended === undefined)
          .map((record) => DateTime.toEpochMillis(record.expiresAt))
          .filter((expiresAt) => expiresAt > now);
        const active = expiries.length > 0;
        let retry = false;
        if (active !== delivered || unsure) {
          const sent = yield* receiver.setCuaWatch(active).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (sent) {
            delivered = active;
            unsure = false;
          } else {
            unsure = true;
            retry = true;
          }
        }
        const waits = [
          ...(active ? [Math.min(...expiries) - now] : []),
          // A failed write is tried again: the desktop may not reconnect to hear it otherwise.
          ...(retry ? [WATCH_RETRY_MS] : []),
        ];
        const woken = PubSub.take(kicks);
        yield* waits.length > 0 ? Effect.race(woken, Effect.sleep(Math.min(...waits))) : woken;
      }
    }).pipe(Effect.forkScoped);
  }

  return ComputerUseLeases.of({
    active: (threadId) =>
      live(threadId).pipe(Effect.map((leases) => Option.fromNullishOr(leases[0]))),
    holder: (except) =>
      live().pipe(
        Effect.map((leases) =>
          Option.fromNullishOr(leases.find((lease) => lease.threadId !== except)),
        ),
      ),
    channelOrigin: Effect.fn("ComputerUseLeases.channelOrigin")(function* (threadId) {
      const read = <A>(effect: Effect.Effect<A, ChannelBotDirectory.ChannelBotDirectoryError>) =>
        effect.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
      if (yield* read(directory.isBotThread(threadId))) return "goat_bot" as const;
      return undefined;
    }),
    state,
    control,
    controlState,
    stop: (threadId) =>
      Effect.sync(() => end(threadId, "stopped")).pipe(
        Effect.tap((stopped) => (stopped ? changed : Effect.void)),
      ),
    stopAll: Effect.sync(() => [...controls.keys()].filter((id) => end(id, "stopped_all"))).pipe(
      Effect.tap(() => changed),
    ),
    grants: live(),
    pause,
    detection: Effect.sync(() => detection),
    resume: Effect.sync(() => {
      paused = undefined;
    }).pipe(Effect.andThen(changed)),
    subscribe: PubSub.subscribe(signals),
    changed,
    proxy,
  });
});

export const layer = Layer.effect(ComputerUseLeases, make).pipe(
  Layer.provide(ChannelBotDirectory.layer),
);
