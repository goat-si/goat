import { classifyNoteEmbed, type NoteEmbedSyntax } from "@goat/client-runtime/notes";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { DownloadIcon, ExternalLinkIcon, FileIcon, LinkIcon } from "~/components/solar";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { downloadMedia } from "../components/media/mediaContent";
import { toastManager } from "../components/ui/toast";
import type { NoteEmbedOptions } from "./noteExtensions";
import { useNoteFileDownload, useNoteFileUrl } from "./useNoteFileUrl";

const FRAME =
  "my-3 rounded-lg outline-none [.ProseMirror-selectednode>&]:ring-2 [.ProseMirror-selectednode>&]:ring-ring";

export function NoteEmbedView(props: NodeViewProps) {
  const options = props.extension.options as NoteEmbedOptions;
  const src = String(props.node.attrs.src ?? "");
  const text = String(props.node.attrs.text ?? "");
  const syntax = (props.node.attrs.syntax ?? "image") as NoteEmbedSyntax;
  const embed = options.notePath
    ? classifyNoteEmbed(options.notePath, src, syntax, text)
    : ({ kind: "unsupported" } as const);
  return (
    <NodeViewWrapper data-note-embed className={FRAME} contentEditable={false}>
      {embed.kind === "image" || embed.kind === "video" || embed.kind === "audio" ? (
        <NoteMedia
          kind={embed.kind}
          environmentId={options.environmentId}
          file={embed.file}
          url={embed.url}
          label={text}
        />
      ) : embed.kind === "file" ? (
        <NoteFileChip environmentId={options.environmentId} file={embed.file} name={embed.name} />
      ) : embed.kind === "player" ? (
        <figure className="grid gap-1.5">
          {/* Players need scripts and their own origin's storage; the src only ever comes from
              the vetted provider templates, and the frame stays cross-origin. */}
          <iframe
            src={embed.embedUrl}
            title={text || `${embed.provider} video`}
            loading="lazy"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            className="aspect-video w-full rounded-lg border-0 bg-muted"
          />
          <figcaption className="text-xs text-muted-foreground">
            {/* Some hosts refuse to play inside the desktop app; the original page always works. */}
            <a href={embed.url} target="_blank" rel="noopener noreferrer" className="underline">
              Open on {embed.provider}
            </a>
          </figcaption>
        </figure>
      ) : embed.kind === "link" ? (
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm hover:bg-accent/60"
        >
          <LinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="grid min-w-0">
            <span className="truncate font-medium">{text && text !== src ? text : embed.host}</span>
            <span className="truncate text-xs text-muted-foreground">
              {embed.host}
              {embed.path === "/" ? "" : embed.path}
            </span>
          </span>
          <ExternalLinkIcon
            aria-hidden
            className="ms-auto size-3.5 shrink-0 text-muted-foreground"
          />
        </a>
      ) : (
        <p className="font-mono text-xs break-all text-muted-foreground">{src}</p>
      )}
    </NodeViewWrapper>
  );
}

function NoteMedia(props: {
  kind: "image" | "video" | "audio";
  environmentId: NoteEmbedOptions["environmentId"];
  file: string | null;
  url: string | null;
  label: string;
}) {
  const signed = useNoteFileUrl(props.file === null ? null : props.environmentId, props.file);
  const url = props.file === null ? props.url : signed.url;
  if (props.file !== null && signed.failed)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <span>Couldn’t load {props.label || "this file"}.</span>
        <Button size="xs" variant="outline" onClick={signed.retry}>
          Retry
        </Button>
      </div>
    );
  if (url === null) return <div className="h-24 rounded-lg bg-muted" aria-busy="true" />;
  // A remote file has no URL to renew, so only note files report loads back.
  const events = props.file === null ? {} : { onError: signed.onError };
  if (props.kind === "video")
    return (
      <video
        src={url}
        controls
        preload="metadata"
        aria-label={props.label || undefined}
        className="max-h-[32rem] w-full rounded-lg bg-black"
        onLoadedData={signed.onLoad}
        {...events}
      />
    );
  if (props.kind === "audio")
    return (
      <audio
        src={url}
        controls
        preload="metadata"
        aria-label={props.label || undefined}
        className="w-full"
        onLoadedData={signed.onLoad}
        {...events}
      />
    );
  return (
    <img
      src={url}
      alt={props.label}
      loading="lazy"
      className="max-h-[32rem] max-w-full rounded-lg"
      onLoad={signed.onLoad}
      {...events}
    />
  );
}

function NoteFileChip(props: {
  environmentId: NoteEmbedOptions["environmentId"];
  file: string;
  name: string;
}) {
  const mint = useNoteFileDownload(props.environmentId, props.file);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const url = await mint();
      if (url === null) throw new Error("The environment is not connected.");
      await downloadMedia(url, props.name);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Couldn’t download ${props.name}`,
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
      <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{props.name}</span>
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label={`Download ${props.name}`}
        disabled={busy || props.environmentId === null}
        onClick={() => void download()}
      >
        <DownloadIcon aria-hidden />
      </Button>
    </div>
  );
}
