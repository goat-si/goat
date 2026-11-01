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
  type ComputerUseCallAdmission,
  type ComputerUseCallReservation,
  type ComputerUseControlEnd,
  type ComputerUseHumanInputSource,
  type ComputerUsePauseReason,
  type CuaAgentBlock,
  cuaAgentBlockUnder,
  type Handoff,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- control ids are minted inside a sync map update.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveSelfInvocation, type SelfInvocation } from "@goat/shared/nodeRuntime";

import * as CuaDriver from "./CuaDriver.ts";
import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";
import { makeCallReservations } from "./ComputerUseCallReservations.ts";
import type { AppHolder } from "./ComputerUseAppLeases.ts";
import {
  type CursorTargetReport,
  nextTurn,
  rememberScope,
  staleCursorReport,
  targeted,
} from "./ComputerUseControl.ts";
import type {
  ComputerUseControl,
  ComputerUseControlState,
  ComputerUseControlSnapshot,
  Interruptions,
} from "./ComputerUseControl.ts";
import { makeForegroundApprovals, makeForegroundAuthority } from "./ComputerUseForeground.ts";
import { type EveryAppKind, makeFullAccessAdmitted } from "./ComputerUseFullAccess.ts";
import { IMPLIED_RECHECK_MS, makeRunEnd } from "./ComputerUseOpenWork.ts";
import { type InputKind, makeAgentInputLog } from "./agentInputLog.ts";
import {
  ComputerUseLeaseError,
  makeLeaseQueries,
  PER_SIGNAL_READ,
} from "./ComputerUseLeaseQueries.ts";
import { appsOf, type ComputerUseHolder, holderOf } from "./computerUseGrants.ts";
import { makeCallReservation } from "./ComputerUseLeaseAdmission.ts";
import { makeStoppedCards } from "./ComputerUseStoppedCards.ts";
import { makeLeaseSafety } from "./ComputerUseLeaseSafety.ts";
import { startHelperWatch } from "./ComputerUseLeaseWatch.ts";

export { ComputerUseLeaseError } from "./ComputerUseLeaseQueries.ts";

export interface ComputerUseLease {
  readonly threadId: ThreadId;
  readonly handoffId: TurnItemId;
  readonly expiresAt: DateTime.Utc;
  /** Absent when the grant admits every app. */
  readonly apps?: ReadonlyArray<string>;
  readonly computerUseForeground?: NonNullable<Handoff["computerUseForeground"]>;
}

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

export type {
  ComputerUseControl,
  ComputerUseControlState,
  Interruptions,
} from "./ComputerUseControl.ts";

/** How long a control without a grant lasts after the turn that last used it. */
const INTERACTIVE_CONTROL_MINUTES = 60;
/**
 * Rounded down to the minute: never past an hour from the last use, and the many calls of a turn
 * move it once a minute, every move announced, so a following proxy holds the server's expiry.
 */
const controlExpiry = (now: DateTime.Utc) =>
  DateTime.makeUnsafe(
    Math.floor(
      DateTime.toEpochMillis(DateTime.add(now, { minutes: INTERACTIVE_CONTROL_MINUTES })) / 60_000,
    ) * 60_000,
  );
/** Separates a control id from a call id in an input log key; a control id never contains it. */
const CALL_KEY = "\u0000";
/** How far a proxy's input report time may be from this server's clock. */
const REPORT_SKEW_MS = 60_000;
/** How many of a batch's events are judged between turns of the server's other work. */
const HUMAN_INPUT_CHUNK = 256;

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
    /** The thread other than `except` holding what `apps` asks for; see holderOf. */
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
      runId?: RunId,
    ) => Effect.Effect<ComputerUseControl>;
    /**
     * A control on every app without a grant, for a run whose thread is in full access (D16). It
     * ends once the thread leaves full access. None for unattended work while another thread
     * holds the screen for its own.
     */
    readonly everyAppControl: (
      threadId: ThreadId,
      unattended: boolean,
      run?: { readonly runId?: RunId; readonly nonPerson?: boolean },
    ) => Effect.Effect<Option.Option<ComputerUseControl>, ComputerUseLeaseError>;
    /**
     * Apps a run with every app or the whole screen named in a request. The host adds them to the
     * driver's manifest, which otherwise holds only the apps open when the driver started, such
     * as a dev build of GOAT launched by this turn. It still leaves out GOAT and credential stores.
     */
    readonly nameApps: (
      threadId: ThreadId,
      controlId: string,
      apps: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    /** The thread's control while an agent can act through it, and the run it was taken for. */
    readonly attached: (threadId: ThreadId) => Effect.Effect<
      Option.Option<{
        readonly controlId: string;
        readonly runId?: RunId;
        readonly everyApp: boolean;
      }>,
      ComputerUseLeaseError
    >;
    /**
     * Runs a grant approval's holder check through its commit with unattended claims held off,
     * so neither lands between the other's check and its commit and two unattended threads
     * never act on the screen at once.
     */
    readonly serializeAdmission: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Reads the current record without minting or reviving a control. */
    readonly currentControl: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ComputerUseControlSnapshot>>;
    /** Where one control stands, for the proxy started with it. */
    readonly controlState: (
      threadId: ThreadId,
      controlId: string,
    ) => Effect.Effect<ComputerUseControlState, ComputerUseLeaseError>;
    readonly callReservation: (
      threadId: ThreadId,
      call: ComputerUseCallReservation,
    ) => Effect.Effect<ComputerUseCallAdmission, ComputerUseLeaseError>;
    /** A control's proxy went away; the apps its calls leased are free at once (D17). */
    readonly releaseApps: (threadId: ThreadId, controlId: string) => Effect.Effect<void>;
    /** A lease stream for this control opened: its proxy is there (D17). */
    readonly streamOpened: (controlId: string) => Effect.Effect<void>;
    readonly foregroundApprovalEpoch: Effect.Effect<number>;
    readonly approveForeground: (handoff: Handoff, observedEpoch: number) => Effect.Effect<void>;
    readonly foregroundAvailable: (
      threadId: ThreadId,
      purpose: string,
    ) => Effect.Effect<boolean, ComputerUseLeaseError>;
    readonly releaseForeground?: (input: {
      readonly threadId: ThreadId;
      readonly controlId: string;
    }) => Effect.Effect<boolean>;
    /**
     * Which other threads use which apps now (D17 leases and calls still out), for discover. It
     * reads without waiting on or changing admission. Optional only so partial test services
     * need not stub it; this service always provides it.
     */
    readonly appHolders?: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<AppHolder>>;
    /** Ends the thread's control; true when one was live. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Records the window an agent's admitted call named, or where its cursor is on it (see
     * withCursor), reported by that control's own proxy; false when not the thread's live one.
     */
    readonly setTarget: (
      threadId: ThreadId,
      controlId: string,
      target: CursorTargetReport,
    ) => Effect.Effect<boolean>;
    /**
     * Keyboard or pointer events a control's proxy saw through its helper (#1235), judged one by
     * one in time order (#1488). An event another agent's input of the same kind covers is
     * dropped, and so is one too old or too far from now to judge. A person's input does not
     * pause admitted work. "agents" when an event was judged, including a person's.
     * Refused when the control is not the thread's live one or no event could be judged.
     */
    readonly humanInput: (
      threadId: ThreadId,
      controlId: string,
      events: ReadonlyArray<{ readonly at: number; readonly source: ComputerUseHumanInputSource }>,
    ) => Effect.Effect<"paused" | "agents" | "refused">;
    /**
     * One of a control's calls that can post input started or ended (#1235). A person's input
     * reported while any agent's input was on its way is that agent's, not a person's. False when
     * the control is not the thread's live one.
     */
    readonly agentInput: (
      threadId: ThreadId,
      controlId: string,
      report: {
        readonly call: string;
        readonly state: "start" | "end";
        readonly at: number;
        readonly kinds?: ReadonlyArray<InputKind>;
      },
    ) => Effect.Effect<boolean>;
    /** Ends every control on this host, returning the threads that held one. */
    readonly stopAll: Effect.Effect<ReadonlyArray<ThreadId>>;
    /**
     * Marks the thread's control idle once no turn can call its driver: no run is open, or the
     * open ones only wait; true when it did. A turn that starts meanwhile keeps the control it
     * reused active.
     */
    readonly turnEnded: (threadId: ThreadId) => Effect.Effect<boolean, ComputerUseLeaseError>;
    /** Checks every acting control for a thread with nothing left open; see turnEnded. */
    readonly settle: Effect.Effect<void>;
    /** Ends every control because computer use was turned off. */
    readonly disable: Effect.Effect<void>;
    /** Every live grant on this host, released ones too, for the kill switch to end. */
    readonly grants: Effect.Effect<ReadonlyArray<ComputerUseLease>, ComputerUseLeaseError>;
    readonly release: (handoffIds: ReadonlyArray<string>) => Effect.Effect<void>; // #1521
    /** Which safety reports this host's helper sends. */
    readonly detection: Effect.Effect<ComputerUseDetection>;
    /** Holds every control on this host until resume. */
    readonly pause: (reason: ComputerUsePauseReason) => Effect.Effect<void>;
    readonly resume: Effect.Effect<void>;
    /** Holds one control for the person its agent asked; the others keep acting. */
    readonly hold: (controlId: string, held: boolean) => Effect.Effect<void>;
    /** Every thread's latest control with where it stands, for the preview session list. */
    readonly sessions: Effect.Effect<
      ReadonlyArray<{
        readonly control: ComputerUseControl;
        readonly state: ComputerUseControlState;
      }>
    >;
    /**
     * Records a turn the desktop gave no driver for want of a grant, so the session list can
     * say so while the turn runs (#1399). A control for the thread or the turn's end clears it.
     */
    readonly blocked: (threadId: ThreadId, block: CuaAgentBlock) => Effect.Effect<void>;
    readonly blockedTurns: Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly block: CuaAgentBlock }>
    >;
    /** Wakes after any admission may have started or ended. Subscribe before reading. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly changed: Effect.Effect<void>;
    readonly onAuthorityChange?: (
      listener: (change: {
        readonly kind: "stop" | "credentialRevoked" | "pause" | "private";
        readonly threadId: ThreadId;
        readonly controlId: string;
      }) => void,
    ) => () => void;
    /** How this server starts its own lease proxy subcommand. */
    readonly proxy: SelfInvocation | undefined;
  }
>()("goat/cua/ComputerUseLeases") {}

interface ControlRecord extends ComputerUseControl {
  readonly idleEpoch?: number;
  readonly identityEpoch: number;
  readonly ended?: ComputerUseControlEnd;
  /** Bumped each time a turn reuses the control, so a turn end read before it cannot end it. */
  readonly uses: number;
  /** Admitted by full access rather than a grant; see everyAppControl. */
  readonly everyApp?: EveryAppKind;
  /** Apps this control named for the driver's manifest; see nameApps. */
  readonly named?: ReadonlyArray<string>;
  /** The run whose attachment last took this control up. */
  readonly runId?: RunId;
  /** Idled while a run waited, keeping its approvals until nothing of the thread is open. */
  readonly waitHeld?: boolean;
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
  let manifestGeneration = 0;
  const proxy = Option.getOrUndefined(yield* resolveSelfInvocation().pipe(Effect.option));
  const fullAccessAdmitted = makeFullAccessAdmitted(sql);
  const controls = new Map<ThreadId, ControlRecord>();
  const authorityListeners = new Set<
    (change: {
      kind: "stop" | "credentialRevoked" | "pause" | "private";
      threadId: ThreadId;
      controlId: string;
    }) => void
  >();
  const notifyAuthority = (change: {
    kind: "stop" | "credentialRevoked" | "pause" | "private";
    threadId: ThreadId;
    controlId: string;
  }) => {
    for (const listener of authorityListeners) listener(change);
  };
  const stoppedCards = makeStoppedCards();
  const reservations = makeCallReservations();
  const foreground = makeForegroundApprovals();
  /** Turns the desktop gave no driver for want of a grant, while they run (#1399). */
  const blockedTurns = new Map<ThreadId, CuaAgentBlock>();
  const admission = yield* Semaphore.make(1);
  let paused: ComputerUsePauseReason | undefined;
  const forPerson = new Set<string>();
  const holdFor = (id: string, on: boolean) => void forPerson[on ? "add" : "delete"](id);
  const changed = PubSub.publish(signals, undefined).pipe(Effect.andThen(kick));
  const { settle, openWork, turnEnded } = makeRunEnd({
    sql,
    foreground,
    controls,
    changed,
    idled: (threadId, controlId, now) => reservations.markStopped(threadId, controlId, now),
    error: (cause) => new ComputerUseLeaseError({ cause }),
  });

  const { live, state } = makeLeaseQueries(sql, stoppedCards.isReleased);

  /** Another thread acting on the screen for unattended work admitted by full access. */
  const unattendedEveryApp = (except: ThreadId | undefined, now: DateTime.Utc) =>
    [...controls.values()].find(
      (record) =>
        record.threadId !== except &&
        record.everyApp === "unattended" &&
        acting(record) &&
        DateTime.toEpochMillis(record.expiresAt) > DateTime.toEpochMillis(now),
    );

  // Any full access run takes the foreground without asking; see ComputerUseForeground.
  const implyFocus = (record: ControlRecord) => {
    if (record.everyApp === undefined || record.runId === undefined) return false;
    if (paused !== undefined || privateHost) return false;
    return foreground.imply(record.threadId, record.controlId, record.runId, record.expiresAt);
  };

  const mint = Effect.fn("ComputerUseLeases.mint")(function* (
    threadId: ThreadId,
    lease: Option.Option<ComputerUseLease>,
    everyApp: ControlRecord["everyApp"],
    runId?: RunId,
    nonPerson = false,
  ) {
    const now = yield* DateTime.now;
    // Checked and claimed with no yield between, so two unattended turns cannot both pass.
    if (everyApp === "unattended" && unattendedEveryApp(threadId, now) !== undefined)
      return undefined;
    const handoffId = Option.isSome(lease) ? lease.value.handoffId : undefined;
    // A driver started for this thread after all; the session list drops the blocked entry.
    if (blockedTurns.delete(threadId)) yield* changed;
    // Read, decision, state change and notice are one synchronous, uninterruptible step: a Stop
    // cannot land between the read and the write, and an interrupt cannot skip the notice of a
    // grant this added or dropped (#1617, #1653).
    return yield* Effect.uninterruptible(
      Effect.suspend(() => {
        const existing = controls.get(threadId);
        if (
          existing !== undefined &&
          existing.ended === undefined &&
          existing.handoffId === handoffId &&
          existing.everyApp === everyApp &&
          DateTime.toEpochMillis(existing.expiresAt) > DateTime.toEpochMillis(now)
        ) {
          const identityChanged = runId !== undefined && runId !== existing.runId;
          const reused: ControlRecord = {
            ...nextTurn(existing),
            identityEpoch: existing.identityEpoch + (identityChanged ? 1 : 0),
            nonPersonFullAccess: everyApp !== undefined && nonPerson,
            uses: existing.uses + 1,
            // Without a grant, a control lasts an hour from its last use; a grant keeps its own.
            ...(Option.isSome(lease) ? {} : { expiresAt: controlExpiry(now) }),
            ...(runId === undefined ? {} : { runId }),
          };
          controls.set(threadId, reused);
          const moved =
            DateTime.toEpochMillis(reused.expiresAt) !== DateTime.toEpochMillis(existing.expiresAt);
          const notice =
            implyFocus(reused) || existing.idle === true || moved || identityChanged
              ? changed
              : Effect.void;
          return Effect.as(notice, reused as ComputerUseControl);
        }
        const next: ControlRecord = {
          controlId: `control:${NodeCrypto.randomUUID()}`,
          threadId,
          expiresAt: Option.isSome(lease) ? lease.value.expiresAt : controlExpiry(now),
          ...(handoffId === undefined ? {} : { handoffId }),
          ...(everyApp === undefined ? {} : { everyApp }),
          nonPersonFullAccess: everyApp !== undefined && nonPerson,
          ...(runId === undefined ? {} : { runId }),
          uses: 0,
          identityEpoch: 0,
        };
        if (existing !== undefined) {
          reservations.forgetClosed(threadId, existing.controlId);
          reservations.markStopped(threadId, existing.controlId, DateTime.toEpochMillis(now));
          foreground.revokeControl(threadId, existing.controlId);
          stoppedCards.replaced(existing);
        }
        controls.set(threadId, next);
        foreground.bindPending(
          threadId,
          next.controlId,
          everyApp === undefined ? handoffId : undefined,
        );
        implyFocus(next);
        return Effect.as(changed, next as ComputerUseControl);
      }),
    );
  });

  const control = (threadId: ThreadId, lease: Option.Option<ComputerUseLease>, runId?: RunId) =>
    mint(threadId, lease, undefined, runId).pipe(
      Effect.map((record) => record as ComputerUseControl),
    );

  const everyAppControl = Effect.fn("ComputerUseLeases.everyAppControl")(function* (
    threadId: ThreadId,
    unattended: boolean,
    run?: { readonly runId?: RunId; readonly nonPerson?: boolean },
  ) {
    if (!unattended)
      return Option.fromNullishOr(
        yield* mint(threadId, Option.none(), "person", run?.runId, run?.nonPerson),
      );
    return yield* admission.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* live(undefined, true)).some((lease) => lease.threadId !== threadId))
          return Option.none<ComputerUseControl>();
        return Option.fromNullishOr(
          yield* mint(threadId, Option.none(), "unattended", run?.runId, true),
        );
      }),
    );
  });

  let interruptions: Interruptions = { count: 0, last: "human_input" };
  const interrupted = (last: ComputerUsePauseReason) => {
    interruptions = { count: interruptions.count + 1, last };
  };

  const controlState = Effect.fn(
    "ComputerUseLeases.controlState",
    PER_SIGNAL_READ,
  )(function* (
    threadId: ThreadId,
    controlId: string,
  ): Effect.fn.Return<ComputerUseControlState, ComputerUseLeaseError> {
    // Time before the record: a record read after it can only be as new as that time.
    const now = yield* DateTime.now;
    const record = controls.get(threadId);
    if (record === undefined) return { _tag: "ended", reason: "revoked" };
    if (record.controlId !== controlId) return { _tag: "ended", reason: "replaced" };
    if (record.ended !== undefined) return { _tag: "ended", reason: record.ended };
    if (DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now))
      return { _tag: "ended", reason: "expired" };
    if (record.everyApp !== undefined && !(yield* fullAccessAdmitted(threadId))) {
      if (end(threadId, "revoked", DateTime.toEpochMillis(now), controlId)) yield* changed;
      return { _tag: "ended", reason: "revoked" };
    }
    const grants = yield* live(undefined, true);
    const others = grants.filter((lease) => lease.threadId !== threadId);
    // An approval that checked holder() before this claim can commit after it. A person's
    // approval wins: the screen is the approved thread's, and Handoffs signals on commit.
    if (record.everyApp === "unattended" && others.length > 0) {
      if (end(threadId, "revoked", DateTime.toEpochMillis(now), controlId)) yield* changed;
      return { _tag: "ended", reason: "revoked" };
    }
    // A secret on screen outranks every other pause and lifts by itself when it loses focus.
    if (privateHost) return { _tag: "paused", reason: "private" };
    if (paused !== undefined) return { _tag: "paused", reason: paused };
    if (forPerson.has(controlId)) return { _tag: "paused", reason: "takeover" };
    const own = stoppedCards.own(grants, threadId);
    yield* settle(threadId);
    const focus = foreground.grants(threadId, controlId, own, DateTime.toEpochMillis(now));
    const focusState = focus.length === 0 ? {} : { foreground: focus };
    // While a run holds implied foreground, re-check soon so a missed run end still ends it.
    const recheck = foreground.impliedRuns(threadId).length > 0 ? IMPLIED_RECHECK_MS : Infinity;
    // Other threads' grants hold apps on this screen until they end, which this state outlasts.
    const active = (apps: ReadonlyArray<string> | undefined, until: number) => {
      const validUntil = Math.min(
        until,
        ...focus.map((grant) => grant.expiresAtMillis),
        ...others.map((lease) => DateTime.toEpochMillis(lease.expiresAt)),
      );
      return {
        _tag: "active",
        expiresAt: record.expiresAt,
        interruptions,
        apps: rememberScope(controls, record, apps),
        identityEpoch: record.identityEpoch,
        wakeAt: Math.min(validUntil, DateTime.toEpochMillis(now) + recheck),
        validUntil,
        ...focusState,
        ...(others.length === 0 ? {} : ({ shared: true } as const)),
        ...(record.idle === true ? ({ idle: true } as const) : {}),
        ...(record.idleEpoch === undefined ? {} : { idleEpoch: record.idleEpoch }),
      } as const;
    };
    if (record.everyApp !== undefined)
      return active(undefined, DateTime.toEpochMillis(record.expiresAt));
    if (record.handoffId !== undefined) {
      const grant = yield* state(threadId, record.handoffId);
      if (grant._tag === "ended") return grant;
      // A shorter desktop approval widens scope only while bound to this control.
      return active(
        focus.length > 0 ? undefined : grant.lease.apps,
        DateTime.toEpochMillis(record.expiresAt),
      );
    }
    // An interactive thread controls the apps its grants name, and only the safe reads without one.
    return active(
      own.length === 0 ? [] : appsOf(own),
      Math.min(
        DateTime.toEpochMillis(record.expiresAt),
        ...own.map((grant) => DateTime.toEpochMillis(grant.expiresAt)),
      ),
    );
  });

  const end = (
    threadId: ThreadId,
    reason: ComputerUseControlEnd,
    now: number,
    expectedId?: string,
  ) => {
    const record = controls.get(threadId);
    if (
      expectedId !== undefined &&
      (record?.controlId !== expectedId || record.ended !== undefined)
    )
      return false;
    foreground.revokeThread(threadId);
    if (record === undefined || record.ended !== undefined) return false;
    controls.set(threadId, { ...record, ended: reason });
    reservations.forgetClosed(threadId, record.controlId);
    reservations.markStopped(threadId, record.controlId, now);
    notifyAuthority({
      kind: reason === "revoked" ? "credentialRevoked" : "stop",
      threadId,
      controlId: record.controlId,
    });
    // A pause belongs to the agents it held; with none left the next one starts unpaused.
    if (![...controls.values()].some((other) => other.ended === undefined)) paused = undefined;
    return true;
  };

  /** Every agent's input calls on this host, keyed by control id and call (#1235). */
  const agentInputs = makeAgentInputLog();
  /**
   * Whether a proxy's report time is close to this server's clock, which the proxy shares on
   * the same host. A report far off is refused, and the log is pruned by this clock alone.
   */
  const nearNow = (at: number) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        agentInputs.prune(now);
        return Math.abs(now - at) <= REPORT_SKEW_MS;
      }),
    );
  /** The thread's control when it is the live one this report names, expiry included. */
  const liveControl = Effect.fn("ComputerUseLeases.liveControl")(function* (
    threadId: ThreadId,
    controlId: string,
  ) {
    const record = controls.get(threadId);
    if (record?.controlId !== controlId || record.ended !== undefined) return undefined;
    // An expired control is ended to every reader even before anything marks it so.
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now)) return undefined;
    return record;
  });

  const pause = (reason: ComputerUsePauseReason) =>
    Effect.sync(() => {
      foreground.clear();
      // A person's input with no agent on the screen is just a person using their computer,
      // also between a thread's turns.
      if (![...controls.values()].some(acting)) return false;
      paused = reason;
      interrupted(reason);
      for (const record of controls.values())
        if (record.ended === undefined)
          notifyAuthority({
            kind: reason === "private" ? "private" : "pause",
            threadId: record.threadId,
            controlId: record.controlId,
          });
      return true;
    }).pipe(Effect.flatMap((held) => (held ? changed : Effect.void)));

  const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const { desktop, linuxHelper, detection } = yield* makeLeaseSafety(changed);
  // Private mode reports are disabled until their host signal is trustworthy (#1695). Restore
  // them only with privateModeOn in ComputerUsePrivateMode.ts.
  const privateHost = false;

  if (Option.isSome(desktop) || Option.isSome(linuxHelper))
    yield* startHelperWatch({
      controls,
      acting,
      grantState: state,
      end,
      signals,
      watchKick,
      manifestGeneration: () => manifestGeneration,
      live: live(),
      receiver: Option.getOrUndefined(desktop),
      linuxHelper,
      driver,
    });

  const calls = makeCallReservation({
    admission,
    controls,
    reservations,
    changed,
    controlState,
    blocked: () => paused !== undefined || privateHost,
    interruptions: () => interruptions.count,
    bound: (threadId, controlId, id) => foreground.bound(id, threadId, controlId),
  });

  return ComputerUseLeases.of({
    active: (threadId) =>
      live(threadId).pipe(Effect.map((leases) => Option.fromNullishOr(leases[0]))),
    holder: Effect.fn("ComputerUseLeases.holder")(function* (
      except: ThreadId | undefined,
      apps: ReadonlyArray<string> | undefined,
    ) {
      const grants = yield* live(undefined, true);
      return holderOf(grants, except, apps, unattendedEveryApp(except, yield* DateTime.now));
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
    nameApps: Effect.fn("ComputerUseLeases.nameApps")(function* (
      threadId: ThreadId,
      controlId: string,
      apps: ReadonlyArray<string>,
    ) {
      const record = controls.get(threadId);
      if (record?.controlId !== controlId || !acting(record)) return;
      const named = [...new Set([...(record.named ?? []), ...apps])].sort();
      if (named.length !== (record.named?.length ?? 0))
        controls.set(threadId, { ...record, named });
      manifestGeneration++;
      yield* kick;
    }),
    attached: Effect.fn("ComputerUseLeases.attached")(function* (threadId: ThreadId) {
      const record = controls.get(threadId);
      if (record === undefined || !acting(record)) return Option.none();
      const state = yield* controlState(threadId, record.controlId);
      if (state._tag !== "active") return Option.none();
      return Option.some({
        controlId: record.controlId,
        everyApp: record.everyApp !== undefined,
        ...(record.runId === undefined ? {} : { runId: record.runId }),
      });
    }),
    serializeAdmission: (effect) => admission.withPermits(1)(effect),
    currentControl: Effect.fn(
      "ComputerUseLeases.currentControl",
      PER_SIGNAL_READ,
    )((threadId) => Effect.sync(() => Option.fromNullishOr(controls.get(threadId)))),
    controlState,
    ...makeForegroundAuthority({
      foreground,
      controls,
      live,
      blocked: () => paused !== undefined || privateHost,
      changed,
      settle,
    }),
    callReservation: calls.reserve,
    releaseApps: calls.releaseApps,
    streamOpened: calls.streamOpened,
    appHolders: calls.appHolders,
    stop: (threadId) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => end(threadId, "stopped", now)),
        Effect.tap((stopped) => (stopped ? changed : Effect.void)),
      ),
    setTarget: Effect.fn("ComputerUseLeases.setTarget")(function* (
      threadId: ThreadId,
      controlId: string,
      target: CursorTargetReport,
    ) {
      const record = yield* liveControl(threadId, controlId);
      if (record === undefined) return false;
      if ("report" in target && staleCursorReport(record, target.report)) return false;
      const next = targeted(record, target);
      if (next === undefined) return true;
      const moved = next.cursor !== record.cursor || next.cursorReport !== record.cursorReport;
      controls.set(threadId, moved ? { ...next, cursorAt: yield* Clock.currentTimeMillis } : next);
      yield* changed;
      return true;
    }),
    humanInput: Effect.fn("ComputerUseLeases.humanInput")(function* (
      threadId: ThreadId,
      controlId: string,
      events: ReadonlyArray<{ readonly at: number; readonly source: ComputerUseHumanInputSource }>,
    ) {
      const sorted = [...events].sort((left, right) => left.at - right.at);
      let judged = false;
      // A batch can hold thousands of events: each chunk is judged against the log as it is when
      // the chunk starts, and the server gets to run its other work between chunks.
      for (let start = 0; start < sorted.length; start += HUMAN_INPUT_CHUNK) {
        if (start > 0) yield* Effect.yieldNow;
        if ((yield* liveControl(threadId, controlId)) === undefined) return "refused" as const;
        // Another agent's input on this host shows up in every helper; only a live control's
        // calls count.
        const live = new Set(
          [...controls.values()]
            .filter((record) => record.ended === undefined)
            .map((record) => record.controlId),
        );
        const now = yield* Clock.currentTimeMillis;
        agentInputs.prune(now);
        const isAgents = agentInputs.judge((key) => live.has(key.slice(0, key.indexOf(CALL_KEY))));
        for (const { at, source } of sorted.slice(start, start + HUMAN_INPUT_CHUNK)) {
          if (Math.abs(now - at) > REPORT_SKEW_MS) continue;
          // The calls that could have covered an older event are forgotten, so it cannot be
          // judged: an agent's own late event would pass for a person's. A person still at the
          // machine makes newer ones.
          if (!agentInputs.remembers(at, now)) continue;
          judged = true;
          if (isAgents(at, source)) continue;
          return "agents" as const;
        }
      }
      return judged ? ("agents" as const) : ("refused" as const);
    }),
    agentInput: Effect.fn("ComputerUseLeases.agentInput")(function* (
      threadId: ThreadId,
      controlId: string,
      report: {
        readonly call: string;
        readonly state: "start" | "end";
        readonly at: number;
        readonly kinds?: ReadonlyArray<InputKind>;
      },
    ) {
      if ((yield* liveControl(threadId, controlId)) === undefined) return false;
      if (!(yield* nearNow(report.at))) return false;
      const key = controlId + CALL_KEY + report.call;
      if (report.state === "start") agentInputs.started(key, report.at, report.kinds);
      else agentInputs.ended(key, report.at);
      return true;
    }),
    stopAll: Effect.map(Clock.currentTimeMillis, (now) => {
      foreground.clear();
      return [...controls.keys()].filter((id) => end(id, "stopped_all", now));
    }).pipe(Effect.tap(() => changed)),
    turnEnded,
    // Fails only on a read; a control left as it was is read again on the next end.
    settle: Effect.suspend(() =>
      Effect.forEach(
        [...controls.values()]
          .filter(
            (record) => acting(record) || (record.ended === undefined && record.waitHeld === true),
          )
          .map((record) => record.threadId),
        (threadId) =>
          turnEnded(threadId).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("computer use control left to expire", { threadId, cause }),
            ),
          ),
        { discard: true },
      ).pipe(
        // A blocked turn has no control; it leaves the list once nothing of it is open.
        Effect.andThen(
          Effect.forEach(
            [...blockedTurns.keys()],
            (threadId) =>
              openWork(threadId).pipe(
                Effect.flatMap((open) =>
                  open || !blockedTurns.delete(threadId) ? Effect.void : changed,
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("blocked computer use turn kept until the next end", {
                    threadId,
                    cause,
                  }),
                ),
              ),
            { discard: true },
          ),
        ),
      ),
    ),
    disable: Effect.map(Clock.currentTimeMillis, (now) => {
      foreground.clear();
      const listed = blockedTurns.size > 0;
      blockedTurns.clear();
      const ended = [...controls.keys()].filter((id) => end(id, "disabled", now));
      // Turning computer use off outranks Stop, so the channel closes a stopped thread's proxy.
      const stopped = [...controls].filter(([, r]) => r.ended?.startsWith("stopped") === true);
      for (const [id, record] of stopped) controls.set(id, { ...record, ended: "disabled" });
      return listed || ended.length > 0 || stopped.length > 0;
    }).pipe(Effect.flatMap((cleared) => (cleared ? changed : Effect.void))),
    grants: live(undefined, true),
    release: (handoffIds) =>
      Effect.sync(() => stoppedCards.release(handoffIds)).pipe(Effect.andThen(changed)),
    pause,
    detection,
    resume: Effect.sync(() => {
      paused = undefined;
    }).pipe(Effect.andThen(changed)),
    hold: (id, on) => Effect.sync(() => holdFor(id, on)).pipe(Effect.andThen(changed)),
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
      ).pipe(Effect.map(stoppedCards.merge)),
    ),
    subscribe: PubSub.subscribe(signals),
    changed,
    onAuthorityChange: (listener) => {
      authorityListeners.add(listener);
      return () => void authorityListeners.delete(listener);
    },
    proxy,
    blocked: (threadId, block) =>
      Effect.sync(() => void blockedTurns.set(threadId, block)).pipe(Effect.andThen(changed)),
    // Read against the helper's latest readiness: a grant that came back is no longer named, and a
    // turn whose grants all came back has nothing to show. Its readiness report wakes the lists.
    blockedTurns: (Option.isSome(desktop) ? desktop.value.cuaReadiness : Effect.succeedNone).pipe(
      Effect.map((report) =>
        [...blockedTurns].flatMap(([threadId, recorded]) => {
          const block = Option.isSome(report)
            ? cuaAgentBlockUnder(recorded, report.value.readiness)
            : recorded;
          return block === undefined ? [] : [{ threadId, block }];
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(ComputerUseLeases, make).pipe(
  Layer.provide(ChannelBotDirectory.layer),
);
