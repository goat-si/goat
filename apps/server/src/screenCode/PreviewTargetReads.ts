// @effect-diagnostics nodeBuiltinImport:off - Image identifiers and reply sizes are owned by this host.
import * as NodeCrypto from "node:crypto";
import {
  PreviewAutomationReadInput,
  type PreviewAutomationSnapshot,
  type ScreenHostCall,
  type ScreenImage,
  type ScreenImageMetadata,
  type ScreenRunError,
  type ScreenTargetRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { observationReplyBudget, type ScreenHostContext } from "./ScreenHostBridge.ts";
import type { ScreenObservations } from "./ScreenObservations.ts";

const fail = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});

/** A cell scope names a selector or an element ref from the latest observation of this tab. */
export const cellScope = (
  value: unknown,
  observations: ScreenObservations,
): { readonly ref: string } | { readonly selector: string } | undefined | ScreenRunError => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid_argument", "Pass scope as {selector} or {ref}.");
  const scope = value as { selector?: unknown; ref?: unknown };
  if (typeof scope.selector === "string" && scope.ref === undefined)
    return { selector: scope.selector };
  if (scope.ref && typeof scope.ref === "object" && scope.selector === undefined) {
    const token = observations.index.resolveElement(
      scope.ref as Parameters<typeof observations.index.resolveElement>[0],
    );
    return token?.startsWith("aria-ref=")
      ? { ref: token.slice("aria-ref=".length) }
      : fail("stale_reference", "Observe the current tab again.");
  }
  return fail("invalid_argument", "Pass scope as {selector} or {ref}.");
};

const decodeReadInput = Schema.decodeUnknownOption(PreviewAutomationReadInput, {
  onExcessProperty: "error",
});

/** Read options for the broker, with the page budget lowered to what one cell reply can carry. */
export const cellReadInput = (
  arg: Record<string, unknown>,
  replyBytes: number,
): { readonly input: PreviewAutomationReadInput } | { readonly error: ScreenRunError } => {
  const { targetRef: _targetRef, scope: _scope, ...options } = arg;
  const decoded = "tabId" in options ? Option.none() : decodeReadInput(options);
  if (Option.isNone(decoded))
    return {
      error: fail(
        "invalid_argument",
        "Read options: format, offset, revision, maxChars, maxBytes, settleMs, timeoutMs.",
      ),
    };
  const maxBytes = Math.min(decoded.value.maxBytes ?? 32_000, replyBytes);
  if (maxBytes < 1_000)
    return { error: fail("output_limit", "Raise returnBytes to read page text.") };
  return { input: { ...decoded.value, maxBytes } };
};

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
