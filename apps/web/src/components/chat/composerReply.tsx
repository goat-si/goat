import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type {
  ComposerContextRecord,
  EnvironmentId,
  ResponseContextRecord,
  ThreadId,
} from "@goat/contracts";
import { assistantCitationLabel } from "@goat/shared/assistantCitations";
import { useNavigate } from "@tanstack/react-router";

import { ReplyIcon } from "~/components/solar";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import {
  isResponseContextRecord,
  responseContextReference,
} from "../../lib/composerContextRecords";
import {
  collectInlineContextIds,
  formatInlineContextReference,
} from "../../lib/composerContextReferences";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell, useServerConfigs } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Whether a thread's server checks replies before an agent reads one; older servers drop them. */
export function useReplyToResponseAvailable(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.replyToResponse === true
  );
}

/**
 * The text a reply sends. The reply leads, so its card sits above the text it is about; text
 * that already points at that response, from a pasted card, keeps its one reference.
 */
export function withReplyReference(prompt: string, replyTo: ResponseContextRecord | null): string {
  if (!replyTo || collectInlineContextIds(prompt).includes(replyTo.contextId)) return prompt;
  return `${formatInlineContextReference(responseContextReference(replyTo))} ${prompt}`;
}

/**
 * A reply whose server would drop it is refused with a sentence. That happens to a reply kept in
 * a draft or the stash after its machine went back to a server without replies.
 */
export function refuseReplyTheServerDrops(
  replyTo: ResponseContextRecord | null,
  environmentId: EnvironmentId,
): boolean {
  if (!replyTo) return false;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  if (config?.environment.capabilities.replyToResponse === true) return false;
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "This machine's server can't take replies",
      description:
        "Update GOAT on that machine, or cancel the reply above the composer and send again.",
    }),
  );
  return true;
}

/**
 * Whether a reply to a response `holderThreadId` holds may go from `threadId`: its own responses
 * always; another thread's only while the client holds that thread's live shell. A deleted or
 * archived thread's shell is gone, and no agent could be sent to read it.
 */
export function replyHolderIsHeld(
  threadId: ThreadId,
  holderThreadId: ThreadId,
  holderShell: Pick<EnvironmentThreadShell, "deletedAt"> | null,
): boolean {
  return holderThreadId === threadId || (holderShell !== null && holderShell.deletedAt == null);
}

const readHolderShell = (environmentId: EnvironmentId, threadId: ThreadId) =>
  readThreadShell(scopeThreadRef(environmentId, threadId));

/** The response a composer draft replies to, if any. */
export const draftReplyTo = (target: ComposerThreadTarget): ResponseContextRecord | null =>
  useComposerDraftStore.getState().getComposerDraft(target)?.replyTo ?? null;

/** A draft reply whose response's thread the client no longer holds is refused with a sentence. */
export function refuseReplyWhoseHolderIsGone(
  replyTo: ResponseContextRecord | null,
  target: ComposerThreadTarget | null,
): boolean {
  if (!replyTo || target === null || typeof target === "string") return false;
  const { citation } = replyTo;
  const holderShell = readHolderShell(citation.environmentId, citation.threadId);
  if (replyHolderIsHeld(target.threadId, citation.threadId, holderShell)) return false;
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Can't find the response this replies to",
      description:
        "GOAT can't find the thread that held it here. It may have been deleted or archived. Cancel the reply above the composer and send again.",
    }),
  );
  return true;
}

/**
 * The send gate: a draft reply the agent could not read is refused with its sentence. `target`
 * is the thread the send goes to, also when the composer edits a queued message there.
 */
export function refuseReplyThatGoesUnread(
  replyTo: ResponseContextRecord | null,
  environmentId: EnvironmentId,
  target: ComposerThreadTarget | null,
): boolean {
  return (
    refuseReplyTheServerDrops(replyTo, environmentId) ||
    refuseReplyWhoseHolderIsGone(replyTo, target)
  );
}

/** Whether a thread shows `threadId`'s history: it is that thread or descends from it by run forks. */
function showsHistoryOf(
  target: { environmentId: EnvironmentId; threadId: ThreadId },
  threadId: ThreadId,
) {
  const seen = new Set<ThreadId>();
  let current: ThreadId | null = target.threadId;
  while (current !== null && !seen.has(current)) {
    if (current === threadId) return true;
    seen.add(current);
    const shell: EnvironmentThreadShell | null = readThreadShell(
      scopeThreadRef(target.environmentId, current),
    );
    current = shell?.forkedFrom?.type === "run" ? shell.forkedFrom.threadId : null;
  }
  return false;
}

/**
 * A stashed reply returns only in a thread that shows its response (the thread that holds it, or
 * a side chat or fork of it), and a pending one wins. The send gate judges whether it may go.
 */
export function restoreStashedReply(
  records: ReadonlyArray<ComposerContextRecord>,
  target: ComposerThreadTarget,
) {
  const reply = records.find(isResponseContextRecord);
  if (!reply || typeof target === "string") return;
  const { citation } = reply;
  if (
    citation.environmentId !== target.environmentId ||
    !showsHistoryOf(target, citation.threadId)
  ) {
    return;
  }
  const store = useComposerDraftStore.getState();
  if (store.getComposerDraft(target)?.replyTo) return;
  store.setReplyTo(target, reply);
}

/** The banner above the composer while a draft replies to a response, with its way out. */
export function useReplyBannerItems(
  target: ComposerThreadTarget,
  replyTo: ResponseContextRecord | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const navigate = useNavigate();
  const setReplyTo = useComposerDraftStore((store) => store.setReplyTo);
  if (!replyTo) return [];
  return [
    {
      id: "reply-to",
      variant: "default",
      icon: <ReplyIcon />,
      title: replyTo.subagents
        ? `Replying to ${replyTo.subagents.map((subagent) => subagent.title).join(", ")}`
        : "Replying to",
      description: (
        <button
          type="button"
          className="cursor-pointer hover:text-foreground"
          onClick={() => void navigate(assistantCitationNavigation(replyTo.citation))}
        >
          {assistantCitationLabel(replyTo.citation)}
        </button>
      ),
      dismissLabel: "Cancel reply",
      onDismiss: () => setReplyTo(target, null),
    },
  ];
}
