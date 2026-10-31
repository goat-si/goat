import type { ComputerUseCallReservation, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isHistoryRead } from "./agentInputLog.ts";
import type { makeComputerUseHistory } from "./ComputerUseHistory.ts";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const roles = new Map([
  ["textbox", "textbox"],
  ["axtextfield", "textbox"],
  ["axtextarea", "textbox"],
  ["button", "button"],
  ["axbutton", "button"],
  ["link", "link"],
  ["axlink", "link"],
  ["checkbox", "checkbox"],
  ["axcheckbox", "checkbox"],
  ["radio", "radio"],
  ["combobox", "combobox"],
  ["menuitem", "menuitem"],
  ["slider", "slider"],
]);

export const recordAdmittedCall = Effect.fn("ComputerUseHistory.recordAdmittedCall")(function* (
  history: Effect.Success<typeof makeComputerUseHistory>,
  threadId: ThreadId,
  call: Extract<ComputerUseCallReservation, { action: "reserve" }>,
  outcome: { readonly reservationId: string } | { readonly refusalCode: string },
) {
  if (isHistoryRead(call.name, call.args)) return;
  const args = isRecord(call.args) ? call.args : {};
  const target = isRecord(args.target) ? args.target : {};
  const label = typeof target.role === "string" ? roles.get(target.role.toLowerCase()) : undefined;
  const typed =
    call.name === "type_text" ? args.text : call.name === "set_value" ? args.value : undefined;
  const appId = call.app ?? call.appLabel?.bundleId;
  yield* history.record({
    threadId,
    ...("reservationId" in outcome
      ? { reservation: { id: outcome.reservationId, controlId: call.controlId } }
      : {}),
    target: {
      kind: "app",
      ...(appId === undefined ? {} : { id: appId }),
      name: call.appLabel?.name ?? "Unknown app",
    },
    method: call.name,
    ...(label ? { targetLabel: label } : {}),
    verdict: "reservationId" in outcome ? "unknown_outcome" : "refused",
    ...("refusalCode" in outcome ? { refusalCode: outcome.refusalCode } : {}),
    ...(typeof typed === "string"
      ? { typed: { length: typed.length, field: "unknown", keep: false } }
      : {}),
  });
});
