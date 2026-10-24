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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveSelfInvocation, type SelfInvocation } from "@goat/shared/nodeRuntime";

import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { approvedApps } from "./ComputerUseScope.ts";

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

/** A thread whose admission overlaps one asked for, by grant or by unattended full access. */
export interface ComputerUseHolder {
  readonly threadId: ThreadId;
  readonly expiresAt: DateTime.Utc;
  /** The holder's apps in the way, as its grant names them; absent when it holds the whole screen. */
  readonly apps?: ReadonlyArray<string>;
}

/** Who holds what an admission would overlap, and until when, as one sentence. */
export const describeHolder = (holder: ComputerUseHolder) =>
  `Thread ${holder.threadId} holds ${holder.apps === undefined ? "the whole screen" : holder.apps.join(", ")} on this host until ${DateTime.formatIso(holder.expiresAt)}.`;

/**
 * Whether the host's helper reports a person's input and secret fields at all: true only for a
 * signal its latest readiness report calls supported.
 */
export interface ComputerUseDetection {
  readonly humanInput: boolean;
  readonly privateMode: boolean;
  /** The helper sends live frames of one window (#1370). */
  readonly frames: boolean;
}

/** One thread's current stretch of computer use, what its proxy was started with. */
export interface ComputerUseControl {
  readonly controlId: string;
  readonly threadId: ThreadId;
  readonly expiresAt: DateTime.Utc;
  /** The grant an unattended control lives on; interactive controls have none. */
  readonly handoffId?: TurnItemId;
  /** The apps it last held while active, so a stopped one keeps its label; absent until then. */
  readonly scope?: { readonly apps: ReadonlyArray<string> | undefined };
  /**
   * Its thread has no open run. It stays valid, so the next turn reuses it without respawning
   * the proxy, but no agent can act on it until then.
   */
  readonly idle?: boolean;
  /** The window the agent's latest admitted call named, as its proxy reported it. */
  readonly target?: { readonly pid: number; readonly windowId: number };
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
      /**
       * Another thread holds a grant on this screen, so this one must not raise windows or move
       * the pointer over it.
       */
      readonly shared?: true;
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
    /**
     * The thread other than `except` whose admission reaches an app `apps` names, or any app
     * when `apps` is absent: a live grant, or unattended work admitted to every app.
     */
    readonly holder: (
      except: ThreadId | undefined,
      apps: ReadonlyArray<string> | undefined,
    ) => Effect.Effect<Option.Option<ComputerUseHolder>, ComputerUseLeaseError>;
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
    /**
     * A control on every app without a grant, for a full access thread on a host that admits
     * those. It ends once the host stops admitting them or the thread leaves full access. None
     * for unattended work while another thread holds the screen for its own.
     */
    readonly everyAppControl: (
      threadId: ThreadId,
      unattended: boolean,
    ) => Effect.Effect<Option.Option<ComputerUseControl>, ComputerUseLeaseError>;
    /**
     * Runs a grant approval's holder check through its commit with unattended claims held off,
     * so neither lands between the other's check and its commit and two unattended threads
     * never act on the screen at once.
     */
    readonly serializeAdmission: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Where one control stands, for the proxy started with it. */
    readonly controlState: (
      threadId: ThreadId,
      controlId: string,
    ) => Effect.Effect<ComputerUseControlState, ComputerUseLeaseError>;
    /** Ends the thread's control; true when one was live. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Records the window an agent's admitted call named, reported by that control's own proxy;
     * false when the control is not the thread's live one.
     */
    readonly setTarget: (
      threadId: ThreadId,
      controlId: string,
      target: { readonly pid: number; readonly windowId: number },
    ) => Effect.Effect<boolean>;
    /** Ends every control on this host, returning the threads that held one. */
    readonly stopAll: Effect.Effect<ReadonlyArray<ThreadId>>;
    /**
     * Marks the thread's control idle once none of its runs is still open; true when it did.
     * A turn that starts meanwhile keeps the control it reused active.
     */
    readonly turnEnded: (threadId: ThreadId) => Effect.Effect<boolean, ComputerUseLeaseError>;
    /** Checks every acting control for a thread with nothing left open; see turnEnded. */
    readonly settle: Effect.Effect<void>;
    /** Ends every control because computer use was turned off. */
    readonly disable: Effect.Effect<void>;
    /** Every live grant on this host, for the kill switch to end. */
    readonly grants: Effect.Effect<ReadonlyArray<ComputerUseLease>, ComputerUseLeaseError>;
    /** Which safety reports this host's helper sends; unattended turns need both. */
    readonly detection: Effect.Effect<ComputerUseDetection>;
    /** Holds every control on this host until resume. */
    readonly pause: (reason: ComputerUsePauseReason) => Effect.Effect<void>;
    readonly resume: Effect.Effect<void>;
    /** Every thread's latest control with where it stands, for the preview session list. */
    readonly sessions: Effect.Effect<
      ReadonlyArray<{
        readonly control: ComputerUseControl;
        readonly state: ComputerUseControlState;
      }>
    >;
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

/**
 * The apps of `held` that `wanted` also reaches, matched as the proxy matches them (case aside);
 * undefined when they share none. Without a list an admission reaches every app, so it overlaps
 * every other: the driver acts under it on the whole desktop and in scripts.
 */
const overlap = (
  held: ReadonlyArray<string> | undefined,
  wanted: ReadonlyArray<string> | undefined,
): { readonly apps?: ReadonlyArray<string> } | undefined => {
  if (held === undefined) return {};
  const names = approvedApps(wanted);
  if (names === undefined) return { apps: held };
  const apps = held.filter((app) => names.has(app.toLowerCase()));
  return apps.length === 0 ? undefined : { apps };
};

interface ControlRecord extends ComputerUseControl {
  readonly ended?: ComputerUseControlEnd;
  /** Bumped each time a turn reuses the control, so a turn end read before it cannot end it. */
  readonly uses: number;
  /** Admitted by the full access setting rather than a grant; see everyAppControl. */
  readonly everyApp?: "interactive" | "unattended";
}

/** Whether an agent can act on the screen through this control now. */
const acting = (record: ControlRecord) => record.ended === undefined && record.idle !== true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* ChannelBotDirectory.ChannelBotDirectory;
  const signals = yield* PubSub.sliding<void>(16);
  // Wakes the desktop watch below; a new control does not wake proxies, so it has its own.
  const watchKick = yield* PubSub.sliding<void>(1);
  const kick = PubSub.publish(watchKick, undefined).pipe(Effect.asVoid);
  const proxy = Option.getOrUndefined(yield* resolveSelfInvocation().pipe(Effect.option));
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  // A failed read admits nothing, so a control living on the setting ends.
  const fullAccessAdmitted = Effect.fn("ComputerUseLeases.fullAccessAdmitted")(
    function* (threadId: ThreadId) {
      if (Option.isNone(settings)) return false;
      if (!(yield* settings.value.getSettings).cuaFullAccessAutoAdmit) return false;
      const rows = yield* sql<{ readonly runtime_mode: string }>`
        SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      return rows[0]?.runtime_mode === "full-access";
    },
    Effect.orElseSucceed(() => false),
  );
  const controls = new Map<ThreadId, ControlRecord>();
  const admission = yield* Semaphore.make(1);
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

  /** Another thread acting on the screen for unattended work admitted by the setting. */
  const unattendedEveryApp = (except: ThreadId | undefined, now: DateTime.Utc) =>
    [...controls.values()].find(
      (record) =>
        record.threadId !== except &&
        record.everyApp === "unattended" &&
        acting(record) &&
        DateTime.toEpochMillis(record.expiresAt) > DateTime.toEpochMillis(now),
    );

  const mint = Effect.fn("ComputerUseLeases.mint")(function* (
    threadId: ThreadId,
    lease: Option.Option<ComputerUseLease>,
    everyApp: ControlRecord["everyApp"],
  ) {
    const now = yield* DateTime.now;
    // Checked and claimed with no yield between, so two unattended turns cannot both pass.
    if (everyApp === "unattended" && unattendedEveryApp(threadId, now) !== undefined)
      return undefined;
    const handoffId = Option.isSome(lease) ? lease.value.handoffId : undefined;
    const existing = controls.get(threadId);
    if (
      existing !== undefined &&
      existing.ended === undefined &&
      existing.handoffId === handoffId &&
      existing.everyApp === everyApp &&
      DateTime.toEpochMillis(existing.expiresAt) > DateTime.toEpochMillis(now)
    ) {
      const { idle, ...rest } = existing;
      const reused: ControlRecord = { ...rest, uses: existing.uses + 1 };
      controls.set(threadId, reused);
      // The session list hid it while idle; it shows again for this turn.
      if (idle === true) yield* changed;
      return reused as ComputerUseControl;
    }
    const next: ControlRecord = {
      controlId: `control:${NodeCrypto.randomUUID()}`,
      threadId,
      expiresAt: Option.isSome(lease)
        ? lease.value.expiresAt
        : DateTime.add(now, { minutes: INTERACTIVE_CONTROL_MINUTES }),
      ...(handoffId === undefined ? {} : { handoffId }),
      ...(everyApp === undefined ? {} : { everyApp }),
      uses: 0,
    };
    controls.set(threadId, next);
    yield* kick;
    // A proxy still holding the previous id hears it was replaced.
    if (existing !== undefined && existing.ended === undefined) yield* changed;
    return next as ComputerUseControl;
  });

  const control = (threadId: ThreadId, lease: Option.Option<ComputerUseLease>) =>
    mint(threadId, lease, undefined).pipe(Effect.map((record) => record as ComputerUseControl));

  const everyAppControl = Effect.fn("ComputerUseLeases.everyAppControl")(function* (
    threadId: ThreadId,
    unattended: boolean,
  ) {
    if (!unattended)
      return Option.fromNullishOr(yield* mint(threadId, Option.none(), "interactive"));
    return yield* admission.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* live()).some((lease) => lease.threadId !== threadId))
          return Option.none<ComputerUseControl>();
        return Option.fromNullishOr(yield* mint(threadId, Option.none(), "unattended"));
      }),
    );
  });

  let interruptions: Interruptions = { count: 0, last: "human_input" };
  const interrupted = (last: ComputerUsePauseReason) => {
    interruptions = { count: interruptions.count + 1, last };
  };

  /** Remembers what an active control held, unless a newer control replaced it meanwhile. */
  const scoped = (record: ControlRecord, apps: ReadonlyArray<string> | undefined) => {
    const current = controls.get(record.threadId);
    if (current?.controlId === record.controlId)
      controls.set(record.threadId, { ...current, scope: { apps } });
    return apps;
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
    if (record.everyApp !== undefined && !(yield* fullAccessAdmitted(threadId))) {
      if (end(threadId, "revoked")) yield* changed;
      return { _tag: "ended", reason: "revoked" };
    }
    const grants = yield* live();
    const others = grants.filter((lease) => lease.threadId !== threadId);
    // An approval that checked holder() before this claim can commit after it. A person's
    // approval wins: the screen is the approved thread's, and Handoffs signals on commit.
    if (record.everyApp === "unattended" && others.length > 0) {
      if (end(threadId, "revoked")) yield* changed;
      return { _tag: "ended", reason: "revoked" };
    }
    // A secret on screen outranks every other pause and lifts by itself when it loses focus.
    if (privateHost) return { _tag: "paused", reason: "private" };
    if (paused !== undefined) return { _tag: "paused", reason: paused };
    // Other threads' grants hold apps on this screen until they end, which this state outlasts.
    const active = (apps: ReadonlyArray<string> | undefined, wakeAt: number) =>
      ({
        _tag: "active",
        expiresAt: record.expiresAt,
        interruptions,
        apps: scoped(record, apps),
        wakeAt: Math.min(wakeAt, ...others.map((lease) => DateTime.toEpochMillis(lease.expiresAt))),
        ...(others.length === 0 ? {} : ({ shared: true } as const)),
      }) as const;
    if (record.everyApp !== undefined)
      return active(undefined, DateTime.toEpochMillis(record.expiresAt));
    if (record.handoffId !== undefined) {
      const grant = yield* state(threadId, record.handoffId);
      if (grant._tag === "ended") return grant;
      return active(grant.lease.apps, DateTime.toEpochMillis(record.expiresAt));
    }
    // An interactive thread controls the apps its grants name, and only the safe reads without one.
    const own = grants.filter((lease) => lease.threadId === threadId);
    return active(
      own.length === 0 ? [] : appsOf(own),
      Math.min(
        DateTime.toEpochMillis(record.expiresAt),
        ...own.map((grant) => DateTime.toEpochMillis(grant.expiresAt)),
      ),
    );
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
      // A person's input with no agent on the screen is just a person using their computer,
      // also between a thread's turns.
      if (![...controls.values()].some(acting)) return false;
      paused = reason;
      interrupted(reason);
      return true;
    }).pipe(Effect.flatMap((held) => (held ? changed : Effect.void)));

  let privateHost = false;
  const desktop = yield* Effect.serviceOption(DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  // The desktop host's helper reports a person's own input and secret fields, and its readiness
  // says which it can detect at all; a standalone server and an older helper report nothing, so
  // they detect neither (#1235). Read on every admission from the receiver's accepted report,
  // so a downgrade counts from the moment it arrives.
  const detection: Effect.Effect<ComputerUseDetection> = Option.isSome(desktop)
    ? desktop.value.cuaReadiness.pipe(
        Effect.map(
          Option.match({
            onNone: () => ({ humanInput: false, privateMode: false, frames: false }),
            onSome: ({ signals, frames }) => ({
              humanInput: signals.humanInput === "supported",
              privateMode: signals.privateMode === "supported",
              frames: frames === true,
            }),
          }),
        ),
      )
    : Effect.succeed({ humanInput: false, privateMode: false, frames: false });
  if (Option.isSome(desktop))
    yield* desktop.value.cuaSafety.pipe(
      Stream.runForEach((report) => {
        if (report.type === "cuaHumanInput") return pause("human_input");
        if (report.type === "cuaReadiness") return changed;
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
          .filter(acting)
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

  const turnEnded = Effect.fn("ComputerUseLeases.turnEnded")(function* (threadId: ThreadId) {
    const before = controls.get(threadId);
    if (before === undefined || before.ended !== undefined) return false;
    // Native subagents work through the parent's provider session, and so its control, on
    // their own child threads; one can outlive a failed parent run. Delegated tasks hold
    // controls of their own.
    const open = yield* sql<{ readonly one: number }>`
      WITH RECURSIVE native(child_thread_id, status) AS (
        SELECT s.child_thread_id, s.status FROM orchestration_v2_projection_subagents s
        WHERE s.thread_id = ${threadId} AND s.origin = 'provider_native'
        UNION
        SELECT s.child_thread_id, s.status FROM orchestration_v2_projection_subagents s
        JOIN native n ON s.thread_id = n.child_thread_id
        WHERE s.origin = 'provider_native'
      )
      SELECT 1 AS one FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId}
        AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      UNION ALL
      SELECT 1 AS one FROM native WHERE status IN ('pending', 'running', 'waiting')
      UNION ALL
      SELECT 1 AS one FROM orchestration_v2_projection_provider_turns
      WHERE status IN ('pending', 'running')
        AND (thread_id = ${threadId} OR thread_id IN (SELECT child_thread_id FROM native))
      LIMIT 1
    `.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
    if (open.length > 0) return false;
    // The read yields: a turn that minted or reused the control since then keeps it.
    const after = controls.get(threadId);
    if (
      after?.controlId !== before.controlId ||
      after.uses !== before.uses ||
      after.ended !== undefined ||
      after.idle === true
    )
      return false;
    controls.set(threadId, { ...after, idle: true });
    yield* changed;
    return true;
  });

  return ComputerUseLeases.of({
    active: (threadId) =>
      live(threadId).pipe(Effect.map((leases) => Option.fromNullishOr(leases[0]))),
    holder: Effect.fn("ComputerUseLeases.holder")(function* (
      except: ThreadId | undefined,
      apps: ReadonlyArray<string> | undefined,
    ) {
      for (const lease of yield* live()) {
        if (lease.threadId === except) continue;
        const shared = overlap(lease.apps, apps);
        if (shared !== undefined)
          return Option.some<ComputerUseHolder>({
            threadId: lease.threadId,
            expiresAt: lease.expiresAt,
            ...shared,
          });
      }
      const admitted = unattendedEveryApp(except, yield* DateTime.now);
      return admitted === undefined
        ? Option.none<ComputerUseHolder>()
        : Option.some<ComputerUseHolder>({
            threadId: admitted.threadId,
            expiresAt: admitted.expiresAt,
          });
    }),
    channelOrigin: Effect.fn("ComputerUseLeases.channelOrigin")(function* (threadId) {
      const read = <A>(effect: Effect.Effect<A, ChannelBotDirectory.ChannelBotDirectoryError>) =>
        effect.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
      if (yield* read(directory.isBotThread(threadId))) return "goat_bot" as const;
      return undefined;
    }),
    state,
    control,
    everyAppControl,
    serializeAdmission: (effect) => admission.withPermits(1)(effect),
    controlState,
    stop: (threadId) =>
      Effect.sync(() => end(threadId, "stopped")).pipe(
        Effect.tap((stopped) => (stopped ? changed : Effect.void)),
      ),
    setTarget: Effect.fn("ComputerUseLeases.setTarget")(function* (
      threadId: ThreadId,
      controlId: string,
      target: { readonly pid: number; readonly windowId: number },
    ) {
      const record = controls.get(threadId);
      if (record?.controlId !== controlId || record.ended !== undefined) return false;
      // An expired control is ended to every reader even before anything marks it so.
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now)) return false;
      if (record.target?.pid === target.pid && record.target.windowId === target.windowId)
        return true;
      controls.set(threadId, {
        ...record,
        target: { pid: target.pid, windowId: target.windowId },
      });
      yield* changed;
      return true;
    }),
    stopAll: Effect.sync(() => [...controls.keys()].filter((id) => end(id, "stopped_all"))).pipe(
      Effect.tap(() => changed),
    ),
    turnEnded,
    // Fails only on a read; a control left as it was is read again on the next end.
    settle: Effect.suspend(() =>
      Effect.forEach(
        [...controls.values()].filter(acting).map((record) => record.threadId),
        (threadId) =>
          turnEnded(threadId).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("computer use control left to expire", { threadId, cause }),
            ),
          ),
        { discard: true },
      ),
    ),
    disable: Effect.sync(() => [...controls.keys()].filter((id) => end(id, "disabled"))).pipe(
      Effect.flatMap((ended) => (ended.length > 0 ? changed : Effect.void)),
    ),
    grants: live(),
    pause,
    detection,
    resume: Effect.sync(() => {
      paused = undefined;
    }).pipe(Effect.andThen(changed)),
    // Suspended: the controls are read each time it runs, never once when the service is built.
    sessions: Effect.suspend(() =>
      Effect.forEach([...controls.values()], (record) =>
        controlState(record.threadId, record.controlId).pipe(
          Effect.orElseSucceed((): ComputerUseControlState => ({
            _tag: "ended",
            reason: "revoked",
          })),
          // Read again: an active state just recorded the scope it holds.
          Effect.map((state) => {
            const current = controls.get(record.threadId);
            const latest = current?.controlId === record.controlId ? current : record;
            return { control: latest as ComputerUseControl, state };
          }),
        ),
      ),
    ),
    subscribe: PubSub.subscribe(signals),
    changed,
    proxy,
  });
});

export const layer = Layer.effect(ComputerUseLeases, make).pipe(
  Layer.provide(ChannelBotDirectory.layer),
);
