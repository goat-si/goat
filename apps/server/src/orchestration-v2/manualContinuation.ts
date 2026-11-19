import { indexRunInputDelivery } from "./inputDeliveryEvidence.ts";
import { MAX_CONTINUATION_CHAIN } from "./ContinuationChain.ts";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";

type Delivery =
  | { readonly type: "native" | "ambiguous" }
  | { readonly type: "replay"; readonly source: OrchestrationV2Run };

type Continuation = Pick<OrchestrationV2Run, "manualContinuationOfRunId">;
type History = Pick<OrchestrationV2ThreadProjection, "runs" | "attempts">;

export function message(
  message: OrchestrationV2ConversationMessage,
  brief: string | undefined,
  delivery: Delivery | undefined,
  nativeResume: boolean,
) {
  if (brief !== undefined) return { ...message, text: brief };
  return delivery?.type === "native" && !nativeResume && message.text.trim() === ""
    ? { ...message, text: "Continue where you left off." }
    : message;
}

export function manualContinuationDelivery(
  run: Continuation | undefined,
  projection: History,
): Delivery {
  let sourceId = run?.manualContinuationOfRunId;
  if (sourceId === undefined) return { type: "native" };
  const runs = new Map(projection.runs.map((source) => [source.id, source]));
  const evidence = indexRunInputDelivery(projection);
  const visited = new Set<OrchestrationV2Run["id"]>();
  while (
    sourceId !== undefined &&
    !visited.has(sourceId) &&
    visited.size <= MAX_CONTINUATION_CHAIN
  ) {
    visited.add(sourceId);
    const source = runs.get(sourceId);
    const input = evidence.get(sourceId);
    if (source === undefined || input === undefined) break;
    if (input.delivery === "accepted") return { type: "native" };
    if (input.delivery !== "unsent") break;
    if (
      !input.replaced &&
      (source.restartContinuationOfRunId !== undefined ||
        source.usageLimitContinuationOfRunId !== undefined)
    )
      break;
    if (input.replaced || source.manualContinuationOfRunId === undefined)
      return { type: "replay", source };
    sourceId = source.manualContinuationOfRunId;
  }
  return { type: "ambiguous" };
}

export function unsentManualContinuationSource(run: Continuation | undefined, projection: History) {
  const delivery = manualContinuationDelivery(run, projection);
  return delivery.type === "replay" ? delivery.source : undefined;
}

export const AMBIGUOUS_RESUME_MESSAGE =
  "GOAT could not confirm whether the provider received the previous message. Send a message to continue.";

export function turnStartMessageIds(run: OrchestrationV2Run | undefined, projection: History) {
  const ids = [];
  const unsentSource = unsentManualContinuationSource(run, projection);
  if (unsentSource !== undefined) ids.push(unsentSource.userMessageId);
  for (let depth = 0; run !== undefined && depth <= MAX_CONTINUATION_CHAIN; depth++) {
    ids.push(run.userMessageId);
    const sourceId = run.restartContinuationOfRunId ?? run.usageLimitContinuationOfRunId;
    if (sourceId === undefined) break;
    run = projection.runs.find((candidate) => candidate.id === sourceId);
  }
  return ids;
}
