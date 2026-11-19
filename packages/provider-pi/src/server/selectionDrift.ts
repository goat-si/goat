import * as Effect from "effect/Effect";
import { piRecordField as field, piRecordString as string, type PiRpcRecord } from "./rpc.ts";

export const recheckPiSelection = Effect.fn("PiSelection.recheck")(function* <E>(
  request: (record: PiRpcRecord) => Effect.Effect<unknown, E>,
  model: string,
  appliedModel: string | null,
  thinking: string | undefined,
  appliedThinking: string | null,
) {
  const modelCached = model !== "default" && model === appliedModel;
  if (!modelCached && !(thinking !== undefined && thinking === appliedThinking)) return undefined;
  const state = yield* request({ type: "get_state" });
  const selected = field(state, "model");
  const liveModel = `${string(selected, "provider")}/${string(selected, "id")}`;
  return {
    modelDrifted: modelCached && liveModel !== appliedModel,
    thinking: string(state, "thinkingLevel") ?? null,
  };
});
