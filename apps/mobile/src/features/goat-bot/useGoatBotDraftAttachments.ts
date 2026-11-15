import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@goat/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import { retainComposerAttachmentFile } from "../../lib/composerAttachmentFiles";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  releaseGoatBotAttachments,
  type GoatBotAttachmentPickTarget,
} from "./GoatBotComposerAttachments";

/**
 * A GOAT Bot message's files before sending, and the picks still bringing more. They belong to the
 * draft's owner (useGoatBotDraftOwner): a new owner or an unmount releases them. A pick also ends
 * when its chat loses focus; the app going to the background does not end it.
 */
export function useGoatBotDraftAttachments(shown: boolean, owner: number) {
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  // Photos still being read after the picker closed; they join the message when they arrive.
  const [intake, setIntake] = useState(0);
  const draftFiles = useRef(new Map<string, () => void>());
  const pickerLifetime = useRef<AbortController | null>(null);
  // The files the message holds by id, kept as they arrive: two answers can land before a render.
  const held = useRef(new Map<string, DraftComposerAttachment>());
  const releaseAll = () => {
    for (const release of draftFiles.current.values()) release();
    draftFiles.current.clear();
  };
  // oxlint-disable-next-line goat/react-effect-budget -- The draft's files go with its owner: released when the owner changes or the screen unmounts, inside that commit.
  useLayoutEffect(() => {
    // This owner's files: the maps are reused, so the cleanup empties them for the next owner.
    const draft = { owner, files: draftFiles.current, held: held.current };
    return () => {
      for (const release of draft.files.values()) release();
      draft.files.clear();
      draft.held.clear();
      setAttachments([]);
    };
  }, [owner]);
  const pickingIn = shown ? owner : null;
  // A layout effect: its cleanup runs inside the commit that changes the chat, so no answer can
  // slip in between the new conversation showing and the old pick ending.
  // oxlint-disable-next-line goat/react-effect-budget -- A pick ends when its chat stops being shown or shows another conversation.
  useLayoutEffect(() => {
    if (pickingIn === null) return;
    const controller = new AbortController();
    pickerLifetime.current = controller;
    return () => {
      controller.abort();
      pickerLifetime.current = null;
      // An ended pick reports no finish, so its count would hold the box busy for good.
      setIntake(0);
    };
  }, [pickingIn]);
  const target = (maxUploadBytes: number | null): GoatBotAttachmentPickTarget => ({
    existingCount: attachments.length,
    maxUploadBytes,
    getLifetime: () => pickerLifetime.current?.signal,
    onIntake: (change) => setIntake((count) => count + change),
    onPicked: (picked, lifetime) => {
      if (lifetime.aborted || lifetime !== pickerLifetime.current?.signal) {
        releaseGoatBotAttachments(picked);
        return null;
      }
      const fresh = picked.filter((attachment) => !held.current.has(attachment.id));
      const room = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - held.current.size);
      const kept = fresh.slice(0, room);
      for (const attachment of kept) {
        held.current.set(attachment.id, attachment);
        if (attachment.fileUri !== undefined) {
          draftFiles.current.set(
            attachment.id,
            retainComposerAttachmentFile(attachment.fileUri, () =>
              releaseGoatBotAttachments([attachment]),
            ),
          );
        }
      }
      if (kept.length > 0) setAttachments((current) => [...current, ...kept]);
      if (kept.length === fresh.length) return null;
      releaseGoatBotAttachments(fresh.slice(room));
      return `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
    },
  });
  const remove = (id: string) => {
    const attachment = held.current.get(id);
    if (attachment === undefined) return;
    held.current.delete(id);
    draftFiles.current.get(id)?.();
    draftFiles.current.delete(id);
    releaseGoatBotAttachments([attachment]);
    setAttachments((current) => current.filter((item) => item.id !== id));
  };
  /** The message went out with its files: this draft no longer owns them. */
  const sent = () => {
    held.current.clear();
    releaseAll();
    setAttachments([]);
  };
  return { attachments, intake, target, remove, sent };
}
