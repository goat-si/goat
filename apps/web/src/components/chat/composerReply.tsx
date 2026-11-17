import type { ComposerContextRecord, EnvironmentId, ResponseContextRecord } from "@goat/contracts";
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
import { useServerConfigs } from "../../state/entities";
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

/** A stashed reply returns only in the thread that holds its response, and a pending one wins. */
export function restoreStashedReply(
  records: ReadonlyArray<ComposerContextRecord>,
  target: ComposerThreadTarget,
) {
  const reply = records.find(isResponseContextRecord);
  if (!reply || typeof target === "string") return;
  const { citation } = reply;
  if (citation.threadId !== target.threadId || citation.environmentId !== target.environmentId) {
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
