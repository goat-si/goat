import type { OrchestrationV2ConversationMessage, ProviderInstanceId } from "@goat/contracts";
import { screenBindingHintsFromOrigin } from "@goat/shared/turnCapabilities";
import type {
  ProviderMemoryPrepareInput,
  ProviderSessionManagerV2Shape,
} from "./ProviderSessionManager.ts";
import { preparedTurnCapabilities } from "./TurnCapabilities.ts";
import { continuationOrigin } from "./ContinuationChain.ts";

export function runScreenBindingHints(
  input: Parameters<
    typeof continuationOrigin<Pick<OrchestrationV2ConversationMessage, "text" | "context">>
  >[0],
) {
  const origin = continuationOrigin(input);
  return origin === undefined
    ? {}
    : {
        screenBindingHints: screenBindingHintsFromOrigin({
          text: origin.message.text,
          records: origin.message.context?.records ?? [],
        }),
      };
}

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

export function openPrepareInput(
  input: Parameters<ProviderSessionManagerV2Shape["open"]>[0],
  providerInstanceId: ProviderInstanceId,
): ProviderMemoryPrepareInput {
  const sandbox = input.runtimePolicy.sandboxPolicy;
  return {
    threadId: input.threadId,
    providerInstanceId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.delegatedTaskId === undefined ? {} : { delegatedTaskId: input.delegatedTaskId }),
    ...(input.memoryGrantCeiling === undefined
      ? {}
      : { memoryGrantCeiling: input.memoryGrantCeiling }),
    ...(input.dispatchScopes === undefined ? {} : { dispatchScopes: input.dispatchScopes }),
    readOnly:
      input.readOnly === true ||
      sandbox === "read-only" ||
      (typeof sandbox === "object" &&
        sandbox !== null &&
        "type" in sandbox &&
        sandbox.type === "readOnly"),
    interactionMode: input.runtimePolicy.interactionMode,
    turnCapabilities: input.turnCapabilities ?? [],
    ...(input.screenBindingHints === undefined
      ? {}
      : { screenBindingHints: input.screenBindingHints }),
  };
}
