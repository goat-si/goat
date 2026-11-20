import type { OrchestrationMessageContext } from "@goat/contracts";
import { referencedComposerContext } from "../lib/composerContext";

export function mergeReferencedComposerContext(
  text: string,
  first?: OrchestrationMessageContext,
  second?: OrchestrationMessageContext,
) {
  const records = new Map((first?.records ?? []).map((record) => [record.contextId, record]));
  for (const record of second?.records ?? []) records.set(record.contextId, record);
  if (records.size === 0) return undefined;
  return referencedComposerContext(text, { version: 1, records: [...records.values()] });
}
