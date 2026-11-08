import {
  botArtifactName,
  botArtifactOpenMessage,
  botArtifactsFailure,
  readWholeBotArtifact,
} from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelReadBotArtifactInput, EnvironmentId } from "@goat/contracts";
import type { AttachmentPreviewFile } from "../../lib/attachmentDownload";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

export interface ImagePreview {
  readonly name: string;
  readonly file: AttachmentPreviewFile;
}

type BotLibraryOpenResult =
  | { readonly kind: "image"; readonly preview: ImagePreview }
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "done" };

const DONE: BotLibraryOpenResult = { kind: "done" };
const SHARE_FAILED = "Could not open the share sheet. Try again.";

/**
 * Reads a Library file and opens it: an image is cached for the in-app preview, any other file
 * goes to the share sheet. Never throws; after an abort it returns "done" and keeps no copy.
 */
export async function openBotLibraryFile(
  environmentId: EnvironmentId,
  relativePath: string,
  signal: AbortSignal,
  botName = "GOAT Bot",
): Promise<BotLibraryOpenResult> {
  const name = botArtifactName(relativePath);
  try {
    const result = await readWholeBotArtifact(
      relativePath,
      async (input: ChannelReadBotArtifactInput) => {
        const answer = await runAtomCommand(
          appAtomRegistry,
          channelEnvironment.readBotArtifact,
          { environmentId, input },
          { label: "GOAT Bot Library file", reportFailure: false },
        );
        if (answer._tag === "Failure") throw squashAtomCommandFailure(answer);
        return answer.value;
      },
      signal,
    );
    if (signal.aborted) return DONE;
    if (result.status !== "ok") {
      return { kind: "message", message: botArtifactOpenMessage(name, result, botName) };
    }
    const attachment = { name, mimeType: result.mimeType };
    // Loaded on open: its file and crypto modules are native and the tab may never open a file.
    const { shareGeneratedAttachment, writeGeneratedAttachmentFile } =
      await import("../../lib/attachmentDownload");
    if (signal.aborted) return DONE;
    if (result.mimeType.startsWith("image/")) {
      const cached = await writeGeneratedAttachmentFile({ bytes: result.bytes, attachment });
      if (signal.aborted) {
        cached.dispose();
        return DONE;
      }
      return { kind: "image", preview: { name, file: cached } };
    }
    const shared = await shareGeneratedAttachment({ bytes: result.bytes, attachment, signal });
    return shared || signal.aborted
      ? DONE
      : { kind: "message", message: "Sharing isn't available on this device." };
  } catch (error) {
    if (signal.aborted) return DONE;
    const message =
      error instanceof Error && error.message === SHARE_FAILED
        ? error.message
        : botArtifactsFailure(error, botName).message;
    return { kind: "message", message };
  }
}
