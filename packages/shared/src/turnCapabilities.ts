import {
  TURN_CAPABILITIES,
  type CapabilityContextRecord,
  type ComposerContextRecord,
  type OrchestrationMessageContext,
  type TurnCapability,
} from "@goat/contracts";

import {
  collectComposerContextReferences,
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";

/** The chip text for `@computer` and `@browser`, the same on every client. */
export const TURN_CAPABILITY_LABEL: Record<TurnCapability, string> = {
  "computer-use": "Computer",
  browser: "Browser",
};

export function turnCapabilityContextRecord(capability: TurnCapability): CapabilityContextRecord {
  return {
    version: 1,
    kind: "capability",
    // One record per capability: a second chip for the same capability shares it.
    contextId: toKindScopedComposerContextId("capability", capability),
    label: TURN_CAPABILITY_LABEL[capability],
    capability,
  };
}

/**
 * The capabilities a message asks for. Only chips still in the text count, so deleting a chip
 * drops its capability the way deleting any other chip drops its context.
 */
export function requestedTurnCapabilities(input: {
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
}): TurnCapability[] {
  const referenced = new Set(
    collectComposerContextReferences(input.text).map((occurrence) => occurrence.contextId),
  );
  const requested = new Set<TurnCapability>();
  for (const record of input.records) {
    if (record.kind === "capability" && "capability" in record && referenced.has(record.contextId))
      requested.add(record.capability);
  }
  return [...requested];
}

/**
 * Adds capability chips to a message an agent or another surface sends, so its turn gets the
 * same per-turn capabilities a person gets from typing `@computer` or `@browser`.
 */
export function withTurnCapabilities(
  message: { readonly text: string; readonly context?: OrchestrationMessageContext | undefined },
  capabilities: ReadonlyArray<TurnCapability>,
): { text: string; context: OrchestrationMessageContext | undefined } {
  const present = new Set(
    requestedTurnCapabilities({
      text: message.text,
      records: message.context?.records ?? [],
    }),
  );
  const missing = [...new Set(capabilities)].filter((capability) => !present.has(capability));
  if (missing.length === 0) return { text: message.text, context: message.context };
  const added = missing.map(turnCapabilityContextRecord);
  const addedIds = new Set(added.map((record) => record.contextId));
  const kept = (message.context?.records ?? []).filter((record) => !addedIds.has(record.contextId));
  const references = added.map((record) => formatComposerContextReference(record)).join(" ");
  return {
    text: `${references} ${message.text}`,
    context: { version: 1, records: [...kept, ...added] },
  };
}

/** The capability a chip's context id names, or undefined for any other id. */
export function turnCapabilityForContextId(contextId: string): TurnCapability | undefined {
  return TURN_CAPABILITIES.find(
    (capability) => turnCapabilityContextRecord(capability).contextId === contextId,
  );
}

/**
 * The capability records a composer's text refers to. A capability chip carries nothing beyond
 * its id, so a client rebuilds the records from the text at send instead of keeping them in
 * the draft.
 */
export function capabilityContextRecordsInText(text: string): CapabilityContextRecord[] {
  const capabilities = new Set(
    collectComposerContextReferences(text).flatMap((occurrence) => {
      const capability =
        occurrence.kind === "capability"
          ? turnCapabilityForContextId(occurrence.contextId)
          : undefined;
      return capability === undefined ? [] : [capability];
    }),
  );
  return [...capabilities].map(turnCapabilityContextRecord);
}
