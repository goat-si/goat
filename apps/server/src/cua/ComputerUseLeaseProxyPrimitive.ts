import { type JsonRpcId, refusal } from "./ComputerUseLeaseResponses.ts";

/** A screen primitive admitted under one driver connection never runs on its replacement. */
export const staleGeneration = (id: JsonRpcId, method: string | undefined) =>
  refusal(
    { possibleCommit: false },
    id,
    method,
    "invalid_target",
    "The driver generation changed before dispatch.",
  );
