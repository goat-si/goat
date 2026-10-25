import type {
  ComputerUseCallReservation,
  ComputerUseControlEnd,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type { ComputerUseControl, ComputerUseControlState } from "./ComputerUseLeases.ts";
import { callResource } from "./ComputerUseCallReservations.ts";
import { allowsForegroundCall } from "./ComputerUseLeaseCallPermissions.ts";
import { takesScreen } from "./ComputerUseScope.ts";

/** The same current authority judges initial admission and the ticket held across a report. */
export const callAdmissionRefusal = (input: {
  readonly call: Extract<ComputerUseCallReservation, { action: "reserve" }>;
  readonly state: ComputerUseControlState;
  readonly current:
    | (ComputerUseControl & {
        readonly uses: number;
        readonly ended?: ComputerUseControlEnd;
        readonly idleEpoch?: number;
      })
    | undefined;
  readonly beforeUses: number | undefined;
  readonly blocked: boolean;
  readonly interruptions: number;
  readonly now: number;
  readonly bound: (id: TurnItemId) => boolean;
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
  return undefined;
};
