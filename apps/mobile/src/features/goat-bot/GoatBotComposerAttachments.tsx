import type { DraftComposerAttachment } from "../../lib/composerImages";
import { pickComposerFiles, pickComposerMedia } from "../../lib/composerImages";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import * as Dialog from "../../components/ui/Dialog";
import type { EnvironmentId } from "@goat/contracts";
import { releaseUnusedComposerAttachmentFiles } from "../../state/use-composer-drafts";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";

async function pickAttachments(
  kind: "media" | "files",
  existingCount: number,
  maxBytes: number | undefined,
) {
  const result =
    kind === "files"
      ? await pickComposerFiles({ existingCount, maxBytes })
      : await pickComposerMedia({ existingCount, maxVideoBytes: maxBytes });
  return { picked: "files" in result ? result.files : result.attachments, error: result.error };
}

/** Deletes the local copies of files taken off a GOAT Bot message before it was sent. */
export function releaseGoatBotAttachments(attachments: ReadonlyArray<DraftComposerAttachment>) {
  void releaseUnusedComposerAttachmentFiles(attachments).catch((error) =>
    console.warn("[goat-bot] could not release attachment files", error),
  );
}

/** What a pick of photos or files needs from the screen it adds to. */
export interface GoatBotAttachmentPickTarget {
  readonly existingCount: number;
  /** Files are offered only when the server takes them; null means photos only. */
  readonly maxUploadBytes: number | null;
  readonly getLifetime: () => AbortSignal | undefined;
  /**
   * Picked files, with the lifetime the pick started in. Returns why some were not added, if any,
   * which the pick then shows instead of a second alert.
   */
  readonly onPicked: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    lifetime: AbortSignal,
  ) => string | null | void;
  /** A pick has started (1) or finished, picked, failed or cancelled (-1). */
  readonly onIntake?: ((change: 1 | -1) => void) | undefined;
}

/**
 * Picks photos or files for the GOAT Bot message being written. A pick that answers after its
 * screen has gone is released, not added, and reports no end to that screen.
 */
export function goatBotAttachmentPick(target: GoatBotAttachmentPickTarget) {
  return async (kind: "media" | "files") => {
    const signal = target.getLifetime();
    if (!signal || signal.aborted) return;
    // Until the picker returns, a photo may still be read or converted: the box is not empty.
    target.onIntake?.(1);
    await pickAttachments(kind, target.existingCount, target.maxUploadBytes ?? undefined)
      .then(
        ({ picked, error }) => {
          if (signal.aborted) {
            releaseGoatBotAttachments(picked);
            return;
          }
          const refused = picked.length > 0 ? target.onPicked(picked, signal) : null;
          const message = error ?? refused;
          if (message) Dialog.alert("Could not attach file", message);
        },
        (cause: unknown) => {
          if (signal.aborted) return;
          Dialog.alert(
            "Could not attach file",
            cause instanceof Error ? cause.message : "Try again.",
          );
        },
      )
      .finally(() => {
        if (!signal.aborted) target.onIntake?.(-1);
      });
  };
}

/** Adds photos or files to the GOAT Bot message being written. */
export function GoatBotAttachButton(
  props: GoatBotAttachmentPickTarget & { readonly disabled: boolean },
) {
  const pick = goatBotAttachmentPick(props);
  return (
    <ComposerAttachmentButton
      disabled={props.disabled}
      supportsFiles={props.maxUploadBytes !== null}
      onPickMedia={() => pick("media")}
      onPickFiles={() => pick("files")}
    />
  );
}

export function GoatBotAttachmentStrip(props: {
  readonly environmentId: EnvironmentId | null;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly onRemove: (id: string) => void;
}) {
  return (
    <ComposerAttachmentStrip
      {...(props.environmentId === null ? {} : { environmentId: props.environmentId })}
      attachments={props.attachments}
      onRemove={props.onRemove}
    />
  );
}
