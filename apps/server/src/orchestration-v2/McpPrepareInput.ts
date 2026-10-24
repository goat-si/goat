import type { ProviderMemoryPrepareInput } from "./ProviderSessionManager.ts";
import { preparedTurnCapabilities } from "./TurnCapabilities.ts";

/**
 * How a prepare reuses earlier admission: `false` admits the caller's input as is, an object is
 * an explicit admission, `true` re-prepares internally (reattach), and `"stored"` re-prepares
 * exactly the admission stored when the prepare lock is held (memory rotation).
 */
export type PrepareReuse = boolean | "stored" | ProviderMemoryPrepareInput;

/**
 * The input one prepare admits, chosen under the per-thread prepare lock from the caller's input
 * and the admission stored now. A memory rotation reads its input before it can take the lock,
 * so it must not carry that copy: a turn that opened in between, even on another provider, wins.
 * Undefined means there is nothing stored to re-prepare.
 */
export function selectPrepareInput<Stored extends ProviderMemoryPrepareInput>(
  input: ProviderMemoryPrepareInput,
  reuse: PrepareReuse,
  stored: Stored | undefined,
): ProviderMemoryPrepareInput | Stored | undefined {
  if (reuse === "stored") return stored;
  const admitted = typeof reuse === "object" ? reuse : stored;
  if (!reuse || admitted?.providerInstanceId !== input.providerInstanceId)
    return { ...input, readOnly: input.readOnly === true };
  const { runId: _previousRun, delegatedTaskId: _previousTask, ...admittedAuthority } = admitted;
  return {
    // Internal reprepare retains this execution's provenance. An
    // explicit admission replaces IDs, including absent IDs.
    ...(reuse === true ? admitted : admittedAuthority),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.delegatedTaskId === undefined ? {} : { delegatedTaskId: input.delegatedTaskId }),
    ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
    ...preparedTurnCapabilities(reuse === true, admitted, input),
    readOnly: admitted.readOnly === true || input.readOnly === true,
  };
}
