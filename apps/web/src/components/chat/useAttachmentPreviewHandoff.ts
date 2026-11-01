import { type EnvironmentId, type MessageId } from "@goat/contracts";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { selectHandoffImageResources } from "../../session-logic";
import type { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { useAssetUrls } from "../../assets/assetUrls";
import {
  dropOptimisticHandoff,
  type OptimisticBlobPreviews,
  type OptimisticUserMessages,
} from "./optimisticUserMessages";

interface AttachmentPreviewHandoffInput {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly serverVisibleTurnItems: ReturnType<typeof useQuietThreadVisibleTurnItems>;
  readonly handoff: OptimisticUserMessages["handoff"];
  readonly blobPreviews: OptimisticBlobPreviews;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<OptimisticUserMessages>>;
}

// Keep the blob preview visible until all of the server's images have loaded.
export function useAttachmentPreviewHandoff(input: AttachmentPreviewHandoffInput) {
  const {
    environmentId,
    threadKey,
    serverVisibleTurnItems,
    handoff,
    blobPreviews,
    setOptimisticUserMessages,
  } = input;
  useEffect(() => () => blobPreviews.revokeThread(threadKey), [blobPreviews, threadKey]);

  const serverAttachmentResources = selectHandoffImageResources(
    Object.keys(handoff).length === 0
      ? undefined
      : serverVisibleTurnItems.flatMap(({ item }) =>
          item.type === "user_message"
            ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
            : [],
        ),
    handoff,
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = new Map(
    serverAttachmentResources.flatMap((resource, index) => {
      const url = serverAttachmentUrls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  useEffect(() => {
    if (typeof Image === "undefined" || serverVisibleTurnItems.length === 0) return;
    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map(
      serverVisibleTurnItems.flatMap((row) =>
        row.item.type === "user_message" ? [[String(row.item.messageId), row.item] as const] : [],
      ),
    );
    for (const [messageId, handoffPreviewUrls] of Object.entries(handoff)) {
      const serverMessage = userMessagesById.get(messageId);
      if (serverMessage === undefined || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image"
          ? [serverAttachmentUrlById.get(attachment.id)].filter(
              (previewUrl): previewUrl is string => previewUrl !== undefined,
            )
          : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          setOptimisticUserMessages((state) =>
            dropOptimisticHandoff(state, threadKey, messageId as MessageId),
          );
          blobPreviews.revoke(threadKey, handoffPreviewUrls);
        })
        .catch(() => {
          // Keep the local preview until a later preload or thread cleanup succeeds.
        });

      cleanups.push(() => {
        cancelled = true;
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [
    handoff,
    threadKey,
    blobPreviews,
    setOptimisticUserMessages,
    serverAttachmentUrlById,
    serverVisibleTurnItems,
  ]);
  const timelineAttachmentUrlById = (() => {
    const urls = new Map(serverAttachmentUrlById);
    for (const row of serverVisibleTurnItems) {
      if (row.item.type !== "user_message") continue;
      const handoffUrls = handoff[row.item.messageId];
      if (handoffUrls === undefined) continue;
      let imageIndex = 0;
      for (const attachment of row.item.attachments) {
        if (attachment.type !== "image") continue;
        const handoffUrl = handoffUrls[imageIndex];
        imageIndex += 1;
        if (handoffUrl !== undefined) urls.set(attachment.id, handoffUrl);
      }
    }
    return urls;
  })();
  return { timelineAttachmentUrlById };
}
