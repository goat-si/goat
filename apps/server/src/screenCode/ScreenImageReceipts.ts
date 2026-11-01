import type { ScreenImageMetadata, ScreenJournalEntry } from "@goat/contracts";
import { isScreenRead, screenActionSafety } from "./ScreenActionOutcome.ts";

export const imageReceipt = (method: ScreenJournalEntry["receipt"]["method"]) => ({
  category: "unverifiable" as const,
  safety: screenActionSafety({ method }, "indeterminate", true),
  evidence: ["read:image_omitted"],
});

export const settleOmittedImages = (
  journal: readonly ScreenJournalEntry[],
  metadata: readonly ScreenImageMetadata[],
) => {
  const omitted = new Set(metadata.filter((item) => item.omitted).map((item) => item.callId));
  return journal.map((entry) =>
    omitted.has(entry.receipt.callId) && isScreenRead(entry.receipt.method)
      ? { ...entry, receipt: { ...entry.receipt, ...imageReceipt(entry.receipt.method) } }
      : entry,
  );
};
