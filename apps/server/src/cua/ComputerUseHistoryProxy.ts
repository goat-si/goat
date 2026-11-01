// @effect-diagnostics preferSchemaOverJson:off -- The proxy receives opaque driver replies.
import type { ComputerUseLeaseCallOutcome } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { driverOutcomeSafety } from "./ComputerUseDriverOutcome.ts";
import { isHistoryRead } from "./agentInputLog.ts";
import { callApp } from "./ComputerUseLeaseProtocol.ts";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export function callOutcome(
  controlId: string,
  call: {
    readonly tool?: string;
    readonly args?: unknown;
    readonly app?: { readonly id: string; readonly name: string };
  },
  line: string,
  status?: string,
): ComputerUseLeaseCallOutcome | undefined {
  if (call.tool === undefined || isHistoryRead(call.tool, call.args)) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    message = {};
  }
  const envelope = isRecord(message) ? message : {};
  const result = isRecord(envelope.result) ? envelope.result : {};
  const error = isRecord(envelope.error) ? envelope.error : {};
  const fields = isRecord(result.structuredContent)
    ? result.structuredContent
    : isRecord(error.data)
      ? error.data
      : {};
  const hit = isRecord(fields.hit) ? fields.hit : {};
  const role = typeof hit.role === "string" ? hit.role.trim() : "";
  const label = typeof hit.label === "string" ? hit.label.trim() : "";
  const targetLabel = role ? (label ? `${role}: ${label}` : role).slice(0, 160) : undefined;
  const safety = driverOutcomeSafety(call.tool, message, call.args);
  const refused =
    safety.writeStatus === "not_started" ||
    safety.writeStatus === "rejected_before_commit" ||
    status === "not_started";
  const code =
    typeof fields.detail === "string"
      ? fields.detail
      : typeof fields.code === "string"
        ? fields.code
        : safety.code;
  const args = isRecord(call.args) ? call.args : {};
  const text =
    call.tool === "type_text" ? args.text : call.tool === "set_value" ? args.value : undefined;
  const typed =
    typeof text === "string" ? { length: text.length, fieldKind: "unknown" as const } : undefined;
  return {
    type: "callOutcome",
    controlId,
    tool: call.tool,
    ...(call.app === undefined ? {} : { app: call.app }),
    ...(targetLabel === undefined ? {} : { targetLabel }),
    verdict: refused
      ? "refused"
      : safety.writeStatus === "committed" && status !== "unknown_outcome"
        ? "sent"
        : "unknown_outcome",
    ...(refused ? { refusalCode: code } : {}),
    ...(typed === undefined ? {} : { typed }),
  };
}

export const historySink = (
  options: {
    readonly controlId: string;
    readonly onCallOutcome?: (outcome: ComputerUseLeaseCallOutcome) => Effect.Effect<unknown>;
  },
  message: import("./ComputerUseLeaseProtocol.ts").Envelope,
  listed: ReadonlyMap<number, import("./ComputerUseScope.ts").ListedApp>,
  sink: import("./ComputerUseLeaseProxyOptions.ts").ReplySink,
  scope: import("effect/Scope").Scope,
): import("./ComputerUseLeaseProxyOptions.ts").ReplySink => {
  const tool =
    message.method === "tools/call" && typeof message.params?.name === "string"
      ? message.params.name
      : undefined;
  let app: { readonly id: string; readonly name: string } | undefined;
  let captured = false;
  const captureTarget = () => {
    if (captured) return;
    captured = true;
    const label = callApp(tool, message.params?.arguments, listed);
    if (app === undefined && label?.bundleId !== undefined && label.name !== undefined)
      app = { id: label.bundleId, name: label.name };
  };
  const call = { ...(tool === undefined ? {} : { tool }), args: message.params?.arguments };
  let recorded = false;
  let reservationId: string | undefined;
  const recordOutcome = Effect.fn("ComputerUseHistoryProxy.recordOutcome")((
    line: string,
    status?: string,
  ) => {
    if (recorded) return Effect.void;
    recorded = true;
    captureTarget();
    const outcome = callOutcome(
      options.controlId,
      { ...call, ...(app === undefined ? {} : { app }) },
      line,
      status,
    );
    const report =
      outcome === undefined || reservationId === undefined
        ? undefined
        : { ...outcome, reservationId };
    return report === undefined || options.onCallOutcome === undefined
      ? Effect.void
      : Effect.forkIn(Effect.ignoreCause(options.onCallOutcome(report)), scope).pipe(Effect.asVoid);
  });
  return {
    captureTarget,
    setReservation: (id) => {
      reservationId = id;
    },
    recordOutcome,
    answer: (line, status, context) =>
      recordOutcome(line, status).pipe(Effect.andThen(sink.answer(line, status, context))),
  };
};
