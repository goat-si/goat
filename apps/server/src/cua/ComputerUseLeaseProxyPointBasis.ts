// @effect-diagnostics preferSchemaOverJson:off -- The provider's JSON-RPC line keeps its opaque fields.
/**
 * A point click names the screenshot its pixels count in by snapshot_id, which the driver checks
 * against the window's frame before sending input. A driver whose click lacks that input could
 * ignore it and click the pixels unchecked, so such a call goes only to a child whose own tool
 * list takes it. A run_steps call holding snapshot_id anywhere, in any step form, needs all three.
 */
import * as Effect from "effect/Effect";

import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { acceptsInput, makeProxyBatchScope } from "./ComputerUseLeaseProxyBatch.ts";
import { type JsonRpcId, refusal } from "./ComputerUseLeaseResponses.ts";

export const POINT_BASIS_UNSUPPORTED =
  "This version of GOAT Computer Use cannot check a point click against the window position of its screenshot, so the call did not run. Click by element_token from the latest read instead.";

const BASIS_TOOLS: ReadonlySet<string> = new Set(["click", "double_click", "right_click"]);

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Whether a snapshot_id appears anywhere in the value; too deep to read counts as one. */
const namesBasis = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return true;
  if (Array.isArray(value)) return value.some((item) => namesBasis(item, depth + 1));
  const fields = record(value);
  if (fields === undefined) return false;
  return (
    fields.snapshot_id !== undefined ||
    Object.values(fields).some((item) => namesBasis(item, depth + 1))
  );
};

/** The click tools the call asks to place by a window basis, its run_steps steps included. */
const basisTools = (name: unknown, args: unknown): ReadonlyArray<string> => {
  if (typeof name === "string" && BASIS_TOOLS.has(name))
    return record(args)?.snapshot_id === undefined ? [] : [name];
  return name === "run_steps" && namesBasis(record(args)?.steps) ? [...BASIS_TOOLS] : [];
};

const makeProxyPointBasis = (
  toolsOf: (child: Running) => Effect.Effect<unknown>,
  current: () => Running | undefined,
) =>
  /** The proxy's refusal for a basis click this child cannot take, or undefined to go on. */
  Effect.fn("ComputerUseLeaseProxy.checkPointBasis")(function* (
    id: JsonRpcId,
    message: Envelope,
    notSent: () => string,
  ) {
    const wanted = basisTools(message.params?.name, message.params?.arguments);
    if (wanted.length === 0) return undefined;
    const child = current();
    if (child === undefined) return notSent();
    const tools = yield* toolsOf(child);
    // The answer speaks for the child that gave it only.
    if (current() !== child) return notSent();
    return wanted.every((tool) => acceptsInput(tools, tool, "snapshot_id"))
      ? undefined
      : refusal(id, message.method, "outside_manifest", POINT_BASIS_UNSUPPORTED);
  });

/** The batch scope, then the point-basis check: the proxy's admission of a call's arguments. */
export const makeProxyCallScope = (
  handshake: Parameters<typeof makeProxyBatchScope>[0],
  current: () => Running | undefined,
) => {
  const batches = makeProxyBatchScope(handshake, current);
  const pointBasis = makeProxyPointBasis(batches.toolsOf, current);
  const scope = Effect.fn("ComputerUseLeaseProxy.scopeCall")(function* (
    id: JsonRpcId,
    line: string,
    message: Envelope,
    notSent: () => string,
  ) {
    const scoped = yield* batches.scope(id, line, message, notSent);
    if ("refused" in scoped) return scoped;
    const refused = yield* pointBasis(id, scoped.message, notSent);
    return refused === undefined ? scoped : { refused };
  });
  return { ...batches, scope };
};
