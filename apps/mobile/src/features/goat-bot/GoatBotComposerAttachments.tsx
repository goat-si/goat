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

/** Adds photos or files to the GOAT Bot message being written. */
export function GoatBotAttachButton(props: {
  readonly disabled: boolean;
  readonly existingCount: number;
  /** Files are offered only when the server takes them; null means photos only. */
  readonly maxUploadBytes: number | null;
  readonly onPicked: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
}) {
  const pick = (kind: "media" | "files") =>
    pickAttachments(kind, props.existingCount, props.maxUploadBytes ?? undefined).then(
      ({ picked, error }) => {
        if (picked.length > 0) props.onPicked(picked);
        if (error) Dialog.alert("Could not attach file", error);
      },
      (cause: unknown) =>
        Dialog.alert(
          "Could not attach file",
          cause instanceof Error ? cause.message : "Try again.",
        ),
    );
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
