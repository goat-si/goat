import type { OrchestrationMessageContext } from "@goat/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@goat/shared/composerContextReferences";

export function queuedReplySnapshot(
  context: OrchestrationMessageContext | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    (context?.records ?? [])
      .filter((record) => record.kind === "response")
      .map((record) => [record.contextId, JSON.stringify(record)]),
  );
}

export function recoverQueuedReplyText(
  text: string,
  context: OrchestrationMessageContext | undefined,
  original: ReadonlyMap<string, string>,
): string {
  const referenced = new Set(
    collectComposerContextReferences(text).map((reference) => reference.contextId),
  );
  const missing = (context?.records ?? []).filter(
    (record) =>
      record.kind === "response" &&
      original.get(record.contextId) !== JSON.stringify(record) &&
      !referenced.has(record.contextId),
  );
  return missing.length === 0
    ? text
    : `${missing.map(formatComposerContextReference).join(" ")} ${text}`;
}
