import type { OrchestrationMessageContext } from "@goat/contracts";
import { referencedComposerContext } from "../lib/composerContext";

export function mergeReferencedComposerContext(
  text: string,
  first?: OrchestrationMessageContext,
  second?: OrchestrationMessageContext,
  preserveContextRecords = false,
) {
  const records = new Map((first?.records ?? []).map((record) => [record.contextId, record]));
  for (const record of second?.records ?? []) records.set(record.contextId, record);
  if (records.size === 0) return undefined;
  const context = { version: 1 as const, records: [...records.values()] };
  return preserveContextRecords ? context : referencedComposerContext(text, context);
}
