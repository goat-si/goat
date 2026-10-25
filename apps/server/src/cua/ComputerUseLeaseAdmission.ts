import type {
  ComputerUseCallAdmission,
  ComputerUseCallReservation,
  ComputerUseControlEnd,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";
import type { ComputerUseControl, ComputerUseControlState } from "./ComputerUseControl.ts";
import { type AppBusy, appNeed, makeAppLeases } from "./ComputerUseAppLeases.ts";
import { callResource, type makeCallReservations } from "./ComputerUseCallReservations.ts";
import { markActed } from "./ComputerUseControl.ts";
import { allowsForegroundCall, withCallPermissions } from "./ComputerUseLeaseCallPermissions.ts";
import { takesScreen } from "./ComputerUseScope.ts";

type AdmissionControl = ComputerUseControl & {
  readonly uses: number;
  readonly ended?: ComputerUseControlEnd;
  readonly idleEpoch?: number;
};

/** The same current authority judges initial admission and the ticket held across a report. */
const callAdmissionRefusal = (input: {
  readonly call: Extract<ComputerUseCallReservation, { action: "reserve" }>;
  readonly state: ComputerUseControlState;
  readonly current: AdmissionControl | undefined;
  readonly beforeUses: number | undefined;
  readonly blocked: boolean;
  readonly interruptions: number;
  readonly now: number;
  readonly bound: (id: TurnItemId) => boolean;
  /** Another thread's app lease in this call's way (D17). */
  readonly appBusy?: AppBusy | undefined;
}) => {
  const { call, state, current, now } = input;
  if (state._tag === "ended") return state.reason;
  if (state._tag === "paused" || input.blocked) return "waiting_for_human";
  if (current?.idle === true && callResource(call) !== "read") return "control_idle";
  if (
    current === undefined ||
    current.controlId !== call.controlId ||
    current.ended !== undefined ||
    current.uses !== input.beforeUses ||
    input.interruptions !== call.interruptions ||
    (current.idleEpoch ?? 0) !== call.idleEpoch
  )
    return "replaced";
  if (DateTime.toEpochMillis(current.expiresAt) <= now || state.wakeAt <= now) return "expired";
  if (!allowsForegroundCall(call, state.foreground, now, input.bound))
    return "foreground_not_approved";
  if (state.shared === true && takesScreen(call.name, call.args)) return "screen_shared";
  if (input.appBusy !== undefined) return "app_busy";
  return undefined;
};

/**
 * ComputerUseLeases.callReservation: a proxy's reserve, validate, release or close, judged under
 * the lease service's admission permit so a check and the claim it allows have no yield between
 * them that another thread's reservation could use.
 */
export const makeCallReservation = <C extends AdmissionControl, E>(deps: {
  readonly admission: Semaphore.Semaphore;
  readonly controls: Map<ThreadId, C>;
  readonly reservations: ReturnType<typeof makeCallReservations>;
  readonly changed: Effect.Effect<void>;
  readonly controlState: (
    threadId: ThreadId,
    controlId: string,
  ) => Effect.Effect<ComputerUseControlState, E>;
  readonly blocked: () => boolean;
  readonly interruptions: () => number;
  readonly bound: (threadId: ThreadId, controlId: string, id: TurnItemId) => boolean;
}) => {
  const { admission, controls, reservations, changed, controlState } = deps;
  /** Whether this control of the thread can still start or run calls: live and not idle. */
  const canAct = (holder: ThreadId, controlId: string) => {
    const record = controls.get(holder);
    return record?.controlId === controlId && record.ended === undefined && record.idle !== true;
  };
  // A pause is host-wide and lifts for every holder at once, so it keeps the holder's apps. A
  // lease whose call carried no app id (an older proxy) holds its process while the control does.
  const appLeases = makeAppLeases({
    holds: (threadId, controlId, app) =>
      controlState(threadId, controlId).pipe(
        Effect.map(
          (state) =>
            state._tag === "paused" ||
            (state._tag === "active" &&
              state.idle !== true &&
              (state.apps === undefined ||
                app === undefined ||
                state.apps.some((name) => name.toLowerCase() === app.toLowerCase()))),
        ),
      ),
  });
  const reserve = Effect.fn("ComputerUseLeases.callReservation")(function* (
    threadId: ThreadId,
    request: ComputerUseCallReservation,
  ): Effect.fn.Return<ComputerUseCallAdmission, E> {
    if (request.action === "release" || request.action === "close") {
      const current = controls.get(threadId);
      if (request.action === "close") appLeases.release(threadId, request.controlId);
      return reservations.release(
        threadId,
        request,
        current?.controlId === request.controlId && current.ended === undefined,
      );
    }
    return yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const call =
          request.action === "validate" ? reservations.lookup(threadId, request) : request;
        if (call === undefined) return { status: "refused", detail: "replaced" } as const;
        if (request.action === "reserve" && markActed(controls, threadId, call)) yield* changed;
        const before = controls.get(threadId);
        const need = appNeed(call);
        // Checking another holder's lease reads its control and yields, so the caller's own
        // authority is read after it: the admission below judges what holds now (#1679 r1).
        const appBusy = yield* appLeases.busy(
          threadId,
          need,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        const state = yield* controlState(threadId, call.controlId);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        // Release and close do not wait on admission: neither can resurrect a yielding validation.
        if (request.action === "validate" && reservations.lookup(threadId, request) !== call)
          return { status: "refused", detail: "replaced" } as const;
        // Another control's window ticket refuses below as target_busy, the narrower answer; a
        // call of another control still running in the app holds it like a lease.
        const inTheWay = reservations.targetBusy(threadId, call)
          ? undefined
          : (appBusy ?? reservations.appTicket(threadId, call, canAct, now));
        const detail = callAdmissionRefusal({
          call,
          state,
          current: controls.get(threadId),
          beforeUses: before?.uses,
          blocked: deps.blocked(),
          interruptions: deps.interruptions(),
          now,
          bound: (id) => deps.bound(threadId, call.controlId, id),
          appBusy: inTheWay,
        });
        if (detail === "app_busy" && inTheWay !== undefined)
          return { status: "refused", detail, ...inTheWay } as const;
        if (detail !== undefined) return { status: "refused", detail } as const;
        if (state._tag !== "active") return { status: "refused", detail: "replaced" } as const;
        // Confirmation retains the original ticket and its conflict coverage until cleanup.
        const decision: ComputerUseCallAdmission =
          request.action === "validate"
            ? { status: "admitted", reservationId: request.reservationId }
            : reservations.reserve(threadId, call, now);
        if (decision.status === "admitted") appLeases.hold(threadId, call.controlId, need, now);
        return withCallPermissions(decision, state);
      }),
    );
  });
  /** The control's proxy went away without closing its driver; its app leases end at once. */
  const releaseApps = (threadId: ThreadId, controlId: string) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        appLeases.release(threadId, controlId);
        // Its calls may still be stopping with their driver; they hold their apps briefly.
        reservations.markStopped(threadId, controlId, DateTime.toEpochMillis(now));
      }),
    );
  return { reserve, releaseApps };
};
