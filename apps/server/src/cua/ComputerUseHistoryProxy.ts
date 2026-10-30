// @effect-diagnostics preferSchemaOverJson:off -- The proxy receives opaque driver replies.
import type { ComputerUseLeaseCallOutcome } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { driverOutcomeSafety } from "./ComputerUseDriverOutcome.ts";
import { isHistoryRead } from "./agentInputLog.ts";

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
  labels: import("./ComputerUseAppLabels.ts").AppLabels,
  sink: import("./ComputerUseLeaseProxyOptions.ts").ReplySink,
  scope: import("effect/Scope").Scope,
): import("./ComputerUseLeaseProxyOptions.ts").ReplySink => {
  const tool =
    message.method === "tools/call" && typeof message.params?.name === "string"
      ? message.params.name
      : undefined;
  const label = labels.forCall(message.params?.arguments);
  const call = {
    ...(tool === undefined ? {} : { tool }),
    args: message.params?.arguments,
    ...(label?.bundleId === undefined || label.name === undefined
      ? {}
      : { app: { id: label.bundleId, name: label.name } }),
  };
  return {
    answer: (line, status, context) => {
      const outcome = callOutcome(options.controlId, call, line, status);
      return outcome === undefined || options.onCallOutcome === undefined
        ? sink.answer(line, status, context)
        : Effect.forkIn(Effect.ignoreCause(options.onCallOutcome(outcome)), scope).pipe(
            Effect.andThen(sink.answer(line, status, context)),
          );
    },
  };
};
