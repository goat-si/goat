// @effect-diagnostics preferSchemaOverJson:off -- The provider's JSON-RPC line keeps its opaque fields.
/**
 * A point click names the screenshot its pixels count in by snapshot_id, which the driver checks
 * against the window's frame before sending input. A driver whose click lacks that input could
 * ignore it and click the pixels unchecked, so such a call goes only to a child whose own tool
 * list takes it, alone or as a run_steps step.
 */
import * as Effect from "effect/Effect";

import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { acceptsInput } from "./ComputerUseLeaseProxyBatch.ts";
import { type JsonRpcId, refusal } from "./ComputerUseLeaseResponses.ts";

export const POINT_BASIS_UNSUPPORTED =
  "This version of GOAT Computer Use cannot check a point click against the window position of its screenshot, so the call did not run. Click by element_token from the latest read instead.";

const BASIS_TOOLS: ReadonlySet<string> = new Set(["click", "double_click", "right_click"]);

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** The click tools the call asks to place by a window basis, its run_steps steps included. */
const basisTools = (name: unknown, args: unknown): ReadonlyArray<string> => {
  if (typeof name === "string" && BASIS_TOOLS.has(name))
    return record(args)?.snapshot_id === undefined ? [] : [name];
  if (name !== "run_steps") return [];
  const steps = record(args)?.steps;
  return (Array.isArray(steps) ? steps : []).flatMap((step) => {
    const tool = record(step)?.tool;
    return typeof tool === "string" && BASIS_TOOLS.has(tool)
      ? basisTools(tool, record(step)?.args)
      : [];
  });
};

export const makeProxyPointBasis = (
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
