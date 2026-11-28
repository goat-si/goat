import { ProviderDriverKind, type OrchestrationV2ProviderThread } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const CLAUDE_ATTACHMENT_MAX_BYTES = 28 * 1024 * 1024;
export const CLAUDE_ATTACHMENT_MAX_PAGES = 100;

export const makeClaudeAttachmentBudget = (used?: { pagesUsed: number; bytesUsed: number }) => ({
  committed: { pages: used?.pagesUsed ?? 0, bytes: used?.bytesUsed ?? 0 },
  pending: { pages: 0, bytes: 0 },
  compacting: null as { pages: number; bytes: number } | null,
  get remainingPages() {
    return CLAUDE_ATTACHMENT_MAX_PAGES - this.committed.pages - this.pending.pages;
  },
  get remainingBytes() {
    return CLAUDE_ATTACHMENT_MAX_BYTES - this.committed.bytes - this.pending.bytes;
  },
});

export const reserveClaudePdfBudget = (
  budget: ReturnType<typeof makeClaudeAttachmentBudget>,
  persist: Effect.Effect<void>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => ({
      budget,
      pages: 0,
      bytes: 0,
      delivered: false,
      refunded: false,
      commit() {
        if (this.delivered) return;
        this.delivered = true;
        budget.pending.pages -= this.pages;
        budget.pending.bytes -= this.bytes;
        budget.committed.pages += this.pages;
        budget.committed.bytes += this.bytes;
      },
      refund() {
        if (!this.delivered || this.refunded) return;
        this.refunded = true;
        budget.committed.pages -= this.pages;
        budget.committed.bytes -= this.bytes;
      },
    })),
    (reservation) =>
      Effect.sync(() => {
        if (reservation.delivered) return;
        budget.pending.pages -= reservation.pages;
        budget.pending.bytes -= reservation.bytes;
      }).pipe(Effect.andThen(persist)),
  );

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
type SupportedClaudeImageMimeType = (typeof SUPPORTED_CLAUDE_IMAGE_MIME_TYPES)[number];
const supportedClaudeImageMimeTypes = new Set<string>(SUPPORTED_CLAUDE_IMAGE_MIME_TYPES);

export function isSupportedClaudeImageMimeType(
  mimeType: string,
): mimeType is SupportedClaudeImageMimeType {
  return supportedClaudeImageMimeTypes.has(mimeType);
}

export function decorateClaudeProviderThread(
  providerThread: OrchestrationV2ProviderThread,
  input: {
    readonly appliedTitles: { readonly get: (nativeThreadId: string) => string | undefined };
    readonly pdfBudgets: ReadonlyMap<string, ReturnType<typeof makeClaudeAttachmentBudget>>;
    readonly applyAppContext: (
      thread: OrchestrationV2ProviderThread,
    ) => OrchestrationV2ProviderThread;
    readonly clearedNativeSessions: ReadonlyMap<string, string>;
  },
): OrchestrationV2ProviderThread {
  const nativeId = providerThread.nativeThreadRef?.nativeId ?? "";
  let next = providerThread;
  const appliedTitle = input.appliedTitles.get(nativeId);
  if (appliedTitle !== undefined) {
    next = { ...next, nativeMetadata: { ...next.nativeMetadata, title: appliedTitle } };
  }
  const budget = input.pdfBudgets.get(nativeId);
  if (budget !== undefined) {
    next = {
      ...next,
      nativeMetadata: {
        ...next.nativeMetadata,
        claudeAttachmentBudget: {
          bytesUsed: budget.committed.bytes,
          pagesUsed: budget.committed.pages,
        },
      },
    };
  }
  next = input.applyAppContext(next);
  const nativeSessionId = input.clearedNativeSessions.get(nativeId);
  if (nativeSessionId !== undefined) {
    next = {
      ...next,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeId: nativeSessionId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
    };
  }
  return next;
}
