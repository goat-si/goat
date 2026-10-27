// @effect-diagnostics nodeBuiltinImport:off - Image identifiers and reply sizes are owned by this host.
import * as NodeCrypto from "node:crypto";
import type {
  PreviewAutomationSnapshot,
  ScreenHostCall,
  ScreenImage,
  ScreenImageMetadata,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { observationReplyBudget, type ScreenHostContext } from "./ScreenHostBridge.ts";
import type { ScreenObservations } from "./ScreenObservations.ts";

const fail = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});

export const observePreviewTarget = Effect.fn("PreviewTargetHost.observe")(function* (input: {
  readonly call: ScreenHostCall;
  readonly context: ScreenHostContext;
  readonly targetRef: ScreenTargetRef;
  readonly connectionId: string;
  readonly controlGeneration: number;
  readonly snapshot: PreviewAutomationSnapshot;
  readonly observations: ScreenObservations;
  readonly arg: Record<string, unknown>;
}) {
  const { call, context, targetRef, connectionId, controlGeneration, snapshot, observations, arg } =
    input;
  const draft = observations.normalizeTabSnapshot({
    targetRef,
    targetGeneration: targetRef.generation,
    connectionId,
    controlGeneration,
    snapshot,
  });
  const mode = arg.mode === "diff" || arg.mode === "query" ? arg.mode : "full";
  const query =
    arg.query && typeof arg.query === "object"
      ? (arg.query as { role?: string; name?: string; text?: string })
      : undefined;
  const baseObservationId =
    typeof arg.baseObservationId === "string" ? arg.baseObservationId : undefined;
  const screenshot = snapshot.screenshot;
  const shot =
    screenshot && screenshot.region && screenshot.scale && screenshot.data
      ? {
          ...screenshot,
          region: screenshot.region,
          scale: screenshot.scale,
          data: screenshot.data,
        }
      : undefined;
  const imageRef = NodeCrypto.randomUUID();
  const regionId = NodeCrypto.randomUUID();
  const imageMetadata = (observationId: string): ScreenImageMetadata | undefined =>
    shot && {
      imageRef,
      callId: call.callId,
      targetId: targetRef.id,
      observationId,
      regionId,
      region: shot.region,
      pixelWidth: shot.width,
      pixelHeight: shot.height,
      scale: shot.scale,
      mimeType: shot.mimeType,
    };
  // Image metadata shares the reply budget with the tree and needs space even when bytes are omitted.
  const reserved = imageMetadata(NodeCrypto.randomUUID());
  const imageReserve = reserved
    ? // @effect-diagnostics-next-line preferSchemaOverJson:off -- measures the bytes the reply will carry.
      Buffer.byteLength(JSON.stringify({ image: { ...reserved, omitted: true } }))
    : 0;
  const observation = yield* Effect.try({
    try: () =>
      observations.renderObservation({
        draft,
        mode,
        ...(baseObservationId ? { baseObservationId } : {}),
        ...(query ? { query } : {}),
        limits: { treeBytes: observationReplyBudget(call, context.limits, imageReserve) },
      }),
    catch: (cause) =>
      fail(
        cause instanceof Error &&
          cause.message === "Screen observation metadata exceeds tree budget"
          ? "tree_limit"
          : "downstream_failure",
        "Observe a smaller tab region and retry.",
      ),
  });
  const metadata = imageMetadata(observation.observationId);
  if (!shot || !metadata) {
    return {
      value: observation,
      category: "confirmed" as const,
      evidence: ["Current tab tree observed"],
    };
  }
  observations.index.putRegion(targetRef.id, observation.observationId, metadata.regionId, {
    ...metadata.region,
    pixelWidth: metadata.pixelWidth,
    pixelHeight: metadata.pixelHeight,
    scale: metadata.scale,
  });
  if (Buffer.from(shot.data, "base64").byteLength > context.limits.imageBytes)
    return {
      value: { ...observation, image: { ...metadata, omitted: true } },
      category: "partial" as const,
      evidence: ["Image exceeded the cell limit"],
    };
  const image: ScreenImage = { ...metadata, bytes: shot.data };
  return {
    value: { ...observation, image: metadata },
    image,
    imageMetadata: metadata,
    category: "confirmed" as const,
    evidence: ["Current tab tree and image observed"],
  };
});
