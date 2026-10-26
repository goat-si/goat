import {
  TURN_CAPABILITIES,
  type CapabilityContextApp,
  type CapabilityContextRecord,
  type ComposerContextId,
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
): { text: string; context?: OrchestrationMessageContext } {
  const present = new Set(
    requestedTurnCapabilities({
      text: message.text,
      records: message.context?.records ?? [],
    }),
  );
  const missing = [...new Set(capabilities)].filter((capability) => !present.has(capability));
  if (missing.length === 0)
    return message.context === undefined
      ? { text: message.text }
      : { text: message.text, context: message.context };
  const added = missing.map(turnCapabilityContextRecord);
  const addedIds = new Set(added.map((record) => record.contextId));
  const kept = (message.context?.records ?? []).filter((record) => !addedIds.has(record.contextId));
  const references = added.map((record) => formatComposerContextReference(record)).join(" ");
  return {
    text: `${references} ${message.text}`,
    context: { version: 1, records: [...kept, ...added] },
  };
}

/**
 * The chip for `@Finder`: computer use for this turn, aimed at one app. The app travels in the
 * context id itself (`app_<hex id>`), so a draft keeps no record for it and the chip survives a
 * copy or a reload like `@computer` does.
 */
export function appCapabilityContextRecord(app: CapabilityContextApp): CapabilityContextRecord {
  return {
    version: 1,
    kind: "capability",
    contextId: appContextId(app.id),
    label: app.name.slice(0, 200),
    capability: "computer-use",
    app: { id: app.id, name: app.name.slice(0, 200) },
  };
}

const APP_CONTEXT_PREFIX = "app_";
/** Longest app id an id-encoded chip carries; context ids hold at most 128 characters. */
const APP_CONTEXT_ID_MAX_BYTES = (128 - APP_CONTEXT_PREFIX.length) / 2;

function appContextId(id: string): ComposerContextId {
  const bytes = new TextEncoder().encode(id).slice(0, APP_CONTEXT_ID_MAX_BYTES);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${APP_CONTEXT_PREFIX}${hex}` as ComposerContextId;
}

/** The app id an app chip's context id carries, or undefined for any other id. */
export function appIdForContextId(contextId: string): string | undefined {
  if (!contextId.startsWith(APP_CONTEXT_PREFIX)) return undefined;
  const hex = contextId.slice(APP_CONTEXT_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The capability a chip's context id names, or undefined for any other id. */
export function turnCapabilityForContextId(contextId: string): TurnCapability | undefined {
  if (appIdForContextId(contextId) !== undefined) return "computer-use";
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
  const capabilities = new Set<TurnCapability>();
  const apps = new Map<string, CapabilityContextRecord>();
  for (const occurrence of collectComposerContextReferences(text)) {
    if (occurrence.kind !== "capability") continue;
    const appId = appIdForContextId(occurrence.contextId);
    if (appId !== undefined) {
      // The chip's label is the app's name; the id is what the host's driver admits.
      if (!apps.has(occurrence.contextId))
        apps.set(
          occurrence.contextId,
          appCapabilityContextRecord({ id: appId, name: occurrence.label || appId }),
        );
      continue;
    }
    const capability = turnCapabilityForContextId(occurrence.contextId);
    if (capability !== undefined) capabilities.add(capability);
  }
  return [...[...capabilities].map(turnCapabilityContextRecord), ...apps.values()];
}
