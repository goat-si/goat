import type { ComputerUseCallReservation, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isHistoryRead } from "./agentInputLog.ts";
import type { makeComputerUseHistory } from "./ComputerUseHistory.ts";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export const recordAdmittedCall = Effect.fn("ComputerUseHistory.recordAdmittedCall")(function* (
  history: Effect.Success<typeof makeComputerUseHistory>,
  threadId: ThreadId,
  call: Extract<ComputerUseCallReservation, { action: "reserve" }>,
  reservationId: string,
) {
  if (isHistoryRead(call.name, call.args)) return;
  const args = isRecord(call.args) ? call.args : {};
  const target = isRecord(args.target) ? args.target : {};
  const label = [target.role, target.name, target.title]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(": ")
    .slice(0, 160);
  const typed =
    call.name === "type_text" ? args.text : call.name === "set_value" ? args.value : undefined;
  const appId = call.app ?? call.appLabel?.bundleId;
  yield* history.record({
    threadId,
    reservation: { id: reservationId, controlId: call.controlId },
    target: {
      kind: "app",
      ...(appId === undefined ? {} : { id: appId }),
      name: call.appLabel?.name ?? "Unknown app",
    },
    method: call.name,
    ...(label ? { targetLabel: label } : {}),
    verdict: "unknown_outcome",
    ...(typeof typed === "string"
      ? { typed: { length: typed.length, field: "unknown", keep: false } }
      : {}),
  });
});
