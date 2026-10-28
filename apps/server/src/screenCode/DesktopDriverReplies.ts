// @effect-diagnostics preferSchemaOverJson:off - Driver replies are bounded by the primitive channel.
/** Driver replies read as host results. */
import * as Schema from "effect/Schema";
import type { ComputerUsePrimitiveReply, ScreenRunError } from "@goat/contracts";
import { ComputerUseRefusalDetail, ComputerUseRefusalReason } from "@goat/contracts";
import { driverOutcomeSafety } from "../cua/ComputerUseDriverOutcome.ts";
import type { ScreenHostDispatchResult } from "./ScreenHostBridge.ts";

const isRefusalReason = Schema.is(ComputerUseRefusalReason);
const isRefusalDetail = Schema.is(ComputerUseRefusalDetail);
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const fail = (
  code: ScreenRunError["code"],
  nextStep = "Observe the desktop and try again.",
): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});
export const driverValue = (reply: ComputerUsePrimitiveReply): unknown => {
  const result = object(reply.result);
  return result?.structuredContent ?? result;
};
const refusalOf = (structured: Record<string, unknown> | undefined) => {
  const app = string(structured?.app);
  const holder = string(structured?.holderThreadId);
  return {
    ...(isRefusalReason(structured?.refused) ? { refused: structured.refused } : {}),
    ...(isRefusalDetail(structured?.detail) ? { detail: structured.detail } : {}),
    ...(app !== undefined && app.length <= 200 ? { app } : {}),
    ...(holder !== undefined && holder.length <= 200 ? { holderThreadId: holder } : {}),
  };
};
/** What the refusal told the agent: why the call did not run and what to do instead. */
const refusalText = (
  result: Record<string, unknown> | undefined,
  structured: Record<string, unknown> | undefined,
): string | undefined => {
  const said =
    string(object(structured?.refusal)?.message) ??
    string(structured?.message) ??
    array(result?.content)
      .map(object)
      .map((part) => (part?.type === "text" ? string(part.text) : undefined))
      .find((text) => text !== undefined);
  return said === undefined || said.length <= 1000 ? said : `${said.slice(0, 999)}…`;
};
/** The driver's own effect and code, kept on a failed call's receipt beside GOAT's error code. */
const driverEvidence = (structured: Record<string, unknown> | undefined) => {
  const effect = string(structured?.effect);
  const code = string(object(structured?.refusal)?.code) ?? string(structured?.code);
  return [
    ...(effect === undefined ? [] : [`driver:effect=${effect.slice(0, 80)}`]),
    ...(code === undefined ? [] : [`driver:code=${code.slice(0, 80)}`]),
  ];
};
export const driverError = (reply: ComputerUsePrimitiveReply): ScreenRunError | undefined => {
  const error = classifyDriverError(reply);
  const evidence = driverEvidence(object(object(reply.result)?.structuredContent));
  return error === undefined || evidence.length === 0 ? error : { ...error, evidence };
};
const classifyDriverError = (reply: ComputerUsePrimitiveReply): ScreenRunError | undefined => {
  if (reply.status === "unknown_outcome")
    return { ...fail("unknown_outcome"), effectStarted: true };
  const result = object(reply.result);
  const structured = object(result?.structuredContent);
  const said = refusalText(result, structured);
  // GOAT refused before the driver: keep its reason so the receipt says why.
  if (reply.status === "not_started")
    return { ...fail("unavailable", said), ...refusalOf(structured) };
  // The lease proxy's rule: the driver's own refusal; an explicit other effect wins over a status.
  if (
    structured !== undefined &&
    (structured.effect === undefined
      ? structured.status === "refused"
      : structured.effect === "refused")
  ) {
    const code = string(object(structured.refusal)?.code) ?? string(structured.code);
    return {
      ...fail(
        code === "invalid_arguments"
          ? "invalid_argument"
          : code === "stale_element_token"
            ? "stale_reference"
            : "permission_denied",
        said,
      ),
      ...refusalOf(structured),
    };
  }
  if (result?.isError === true || reply.error !== undefined)
    return structured?.effect === "unverifiable"
      ? { ...fail("unknown_outcome"), effectStarted: true }
      : fail("downstream_failure");
  return undefined;
};

/** An input tool's answer as a receipt category, read the way computer use reads it. */
export const driverResult = (
  tool: string,
  reply: ComputerUsePrimitiveReply,
): ScreenHostDispatchResult => {
  const value = driverValue(reply);
  const effect = object(value)?.effect;
  const category =
    effect === "confirmed" || effect === "partial" || effect === "refused"
      ? effect
      : effect === "suspected_noop" || effect === "no_drop" || effect === "not_applied"
        ? "suspected_noop"
        : "unverifiable";
  return {
    value,
    category,
    // A result that did not do what was asked fails at the bridge; it keeps the driver's words.
    evidence:
      effect === "confirmed"
        ? ["driver:effect=confirmed"]
        : category === "unverifiable"
          ? []
          : driverEvidence(object(value)),
    safety: driverOutcomeSafety(tool, reply),
  };
};
