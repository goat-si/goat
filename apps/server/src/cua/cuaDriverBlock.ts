import { type CuaAgentBlock, cuaAgentBlockUnder, type ComputerUseReadiness } from "@goat/contracts";
import * as Option from "effect/Option";

type DriverFailure =
  | { readonly _tag: "CuaDriverStartError" }
  | { readonly _tag: "CuaDriverHostError"; readonly block?: CuaAgentBlock | undefined };

/** The typed reason behind a failed start, when agents cannot get past it alone. */
export const agentBlock = (failure: Option.Option<DriverFailure>) =>
  Option.isSome(failure) && failure.value._tag === "CuaDriverHostError"
    ? failure.value.block
    : undefined;

/**
 * The block that still explains anything: the grants the helper's newer readiness does not
 * report granted; once every one is back, the last failure is history and the next start tries
 * again.
 */
export const currentBlock = (
  failure: Option.Option<DriverFailure>,
  readiness: ComputerUseReadiness | undefined,
) => {
  const block = agentBlock(failure);
  return block === undefined || readiness === undefined
    ? block
    : cuaAgentBlockUnder(block, readiness);
};
