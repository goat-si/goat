import {
  BOT_ARTIFACT_MAX_SHOWN_TEXT_BYTES,
  botArtifactName,
  botArtifactOpenMessage,
  botArtifactSizeLabel,
  botArtifactViewKind,
  botArtifactsFailure,
  botFileReads,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  ChannelBotArtifact,
  ChannelReadBotArtifactInput,
  EnvironmentId,
} from "@goat/contracts";
import { useEffect, useEffectEvent, useState, type KeyboardEvent } from "react";

import { DownloadIcon, XIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { useGoatBotName } from "./goatBotMemberContext";
import { HoldsNavigation } from "~/lib/navigationHolds";

type View =
  | { readonly kind: "opening" }
  | { readonly kind: "message"; readonly message: string }
  | {
      readonly kind: "file";
      readonly show: ReturnType<typeof botArtifactViewKind>;
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly mimeType: string;
      /** The decoded text for markdown and text files, an object URL for images. */
      readonly content: string;
    };

function download(name: string, bytes: Uint8Array<ArrayBuffer>, mimeType: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface FileViewerProps {
  readonly environmentId: EnvironmentId;
  readonly file: ChannelBotArtifact;
  readonly onClose: () => void;
}

/**
 * A Library file in place of the conversation, read chunk by chunk from the bot's home server.
 * The composer stays below it, so the chat can go on about the file. Try again reads it afresh.
 */
export function GoatBotFileViewer(props: FileViewerProps) {
  const [attempt, setAttempt] = useState(0);
  return <FileViewer key={attempt} {...props} onRetry={() => setAttempt((count) => count + 1)} />;
}

function FileViewer({
  environmentId,
  file,
  onClose,
  onRetry,
}: FileViewerProps & { readonly onRetry: () => void }) {
  const botName = useGoatBotName();
  const name = botArtifactName(file.relativePath);
  const read = useAtomCommand(channelEnvironment.readBotArtifact, { reportFailure: false });
  const [view, setView] = useState<View>({ kind: "opening" });
  // A new command function arrives every render; reading through an effect event keeps one read per file.
  const readChunk = useEffectEvent(async (input: ChannelReadBotArtifactInput) => {
    const answer = await read({ environmentId, input });
    if (answer._tag === "Failure") throw squashAtomCommandFailure(answer);
    return answer.value;
  });
  // oxlint-disable-next-line goat/react-effect-budget -- The read outlives a render; closing or switching files stops it and lets an image's URL go.
  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | null = null;
    void (async () => {
      try {
        const result = await botFileReads.open(
          environmentId,
          readChunk,
          file.relativePath,
          controller.signal,
        );
        if (result === null || controller.signal.aborted) return;
        if (result.status !== "ok") {
          setView({ kind: "message", message: botArtifactOpenMessage(name, result, botName) });
          return;
        }
        const show = botArtifactViewKind(result.mimeType, file.relativePath, result.size);
        if (show === "image")
          imageUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
        setView({
          kind: "file",
          show,
          bytes: result.bytes,
          mimeType: result.mimeType,
          content: imageUrl ?? (show === "download" ? "" : new TextDecoder().decode(result.bytes)),
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setView({ kind: "message", message: botArtifactsFailure(error, botName).message });
      }
    })();
    return () => {
      controller.abort();
      if (imageUrl !== null) URL.revokeObjectURL(imageUrl);
    };
  }, [environmentId, file.relativePath, name, botName]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return (
    <section aria-label={name} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      {/* The file covers the chat with no URL change, so a New bot answering now must not leave it. */}
      <HoldsNavigation />
      <header className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pt-3 pb-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Close ${name}`}
          autoFocus
          onClick={onClose}
        >
          <XIcon />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{name}</h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {botArtifactSizeLabel(file.size)}
        </span>
        {view.kind === "file" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Download ${name}`}
            onClick={() => download(name, view.bytes, view.mimeType)}
          >
            <DownloadIcon />
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          {view.kind === "opening" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Opening…
            </p>
          ) : view.kind === "message" ? (
            <div className="space-y-2 text-sm">
              <p>{view.message}</p>
              <Button size="xs" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            </div>
          ) : view.show === "markdown" ? (
            <ChatMarkdown
              text={view.content}
              cwd={undefined}
              environmentId={environmentId}
              fileActions={false}
            />
          ) : view.show === "text" ? (
            <pre className="overflow-x-auto font-mono text-xs leading-5 whitespace-pre-wrap">
              {view.content}
            </pre>
          ) : view.show === "image" ? (
            <img src={view.content} alt={name} className="max-w-full rounded-lg" />
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {view.bytes.length > BOT_ARTIFACT_MAX_SHOWN_TEXT_BYTES &&
                !view.mimeType.startsWith("image/")
                  ? "This file is too long to show here."
                  : "This file can't be shown here."}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => download(name, view.bytes, view.mimeType)}
              >
                <DownloadIcon />
                Download
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
