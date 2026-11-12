import {
  botArtifactName,
  botArtifactPreview,
  botArtifactPreviewSlot,
  botArtifactViewKind,
  goatBotReplyFiles,
  goatBotReplyMayNameFile,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotArtifact, EnvironmentId } from "@goat/contracts";
import { createContext, memo, use, useEffect, useEffectEvent, useState } from "react";

import { FileIcon, FileTextIcon, ImageIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { queuePreviewRead } from "./goatBotFileReads";
import { GOAT_BOT_PREVIEW_REMARK_PLUGINS } from "./goatBotPreviewMarkdown";

/** The bot's server and how to open one of its Library files; null outside a bot chat. */
export const GoatBotOpenFileContext = createContext<{
  readonly environmentId: EnvironmentId;
  readonly open: (file: ChannelBotArtifact) => void;
} | null>(null);

const KIND_LABEL = { markdown: "Document", text: "Text", image: "Image", download: "File" };

type Preview =
  | { readonly kind: "markdown" | "text"; readonly text: string }
  | { readonly kind: "image"; readonly url: string }
  | null;

/** Cards under a bot reply for each Library file it names, so the person can open it. */
export const GoatBotReplyFiles = memo(function GoatBotReplyFiles({
  text,
}: {
  readonly text: string;
}) {
  const files = use(GoatBotOpenFileContext);
  const environmentId = files?.environmentId ?? null;
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.goatBotLibrary === true;
  const wanted = environmentId !== null && supported && goatBotReplyMayNameFile(text);
  const listing = useEnvironmentQuery(
    wanted ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null,
  );
  const data = wanted ? (listing.data ?? null) : null;
  const named = data === null ? [] : goatBotReplyFiles(text, data.artifacts, data.root);
  if (files === null || named.length === 0) return null;
  return (
    <div className="flex w-full max-w-[min(100%,34rem)] flex-col gap-2 pt-1.5">
      {named.map((file) => (
        <GoatBotFileCard
          key={`${file.relativePath}:${file.modifiedAt}`}
          environmentId={files.environmentId}
          file={file}
          onOpen={() => files.open(file)}
        />
      ))}
    </div>
  );
});

function GoatBotFileCard({
  environmentId,
  file,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly file: ChannelBotArtifact;
  readonly onOpen: () => void;
}) {
  const name = botArtifactName(file.relativePath);
  const kind = botArtifactViewKind("", file.relativePath, file.size);
  const read = useAtomCommand(channelEnvironment.readBotArtifact, { reportFailure: false });
  const [preview, setPreview] = useState<Preview>(null);
  const readFirstChunk = useEffectEvent(() =>
    queuePreviewRead(environmentId, () =>
      read({ environmentId, input: { relativePath: file.relativePath } }),
    ),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- The first chunk arrives after render; a card that goes leaves the queue and lets its image URL go.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const pending = readFirstChunk();
    void pending.result.then((answer) => {
      if (cancelled || answer === null || answer._tag !== "Success") return;
      const next = botArtifactPreview(answer.value);
      if (next?.kind === "image") {
        url = URL.createObjectURL(new Blob([next.bytes], { type: next.mimeType }));
        setPreview({ kind: "image", url });
        return;
      }
      setPreview(next);
    });
    return () => {
      cancelled = true;
      pending.cancel();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, []);
  const shown = preview?.kind ?? kind;
  const slot = botArtifactPreviewSlot(file.relativePath, file.size);
  const Icon = shown === "image" ? ImageIcon : shown === "download" ? FileIcon : FileTextIcon;
  return (
    <div className="relative flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-background hover:bg-accent/40 has-focus-visible:outline-2 has-focus-visible:outline-ring">
      {/* The room is kept before the file is read, so the chat doesn't jump when it arrives. */}
      {slot !== null ? (
        <div
          aria-hidden
          inert
          className={cn(
            "overflow-hidden",
            slot === "image" ? "h-56 bg-muted/40" : "h-40",
            preview !== null &&
              preview.kind !== "image" &&
              "px-4 pt-3 text-xs [mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
          )}
        >
          {preview?.kind === "image" ? (
            <img src={preview.url} alt="" className="size-full object-cover" />
          ) : preview?.kind === "markdown" ? (
            <ChatMarkdown
              text={preview.text}
              cwd={undefined}
              fileActions={false}
              parseRawHtml={false}
              extraRemarkPlugins={GOAT_BOT_PREVIEW_REMARK_PLUGINS}
            />
          ) : preview !== null ? (
            <span className="font-mono leading-5 whitespace-pre-wrap text-muted-foreground">
              {preview.text}
            </span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${name}`}
        className="flex items-center gap-2.5 border-t border-border px-4 py-2.5 text-left outline-none first:border-t-0 after:absolute after:inset-0"
      >
        <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">{KIND_LABEL[shown]}</span>
        </span>
      </button>
    </div>
  );
}
