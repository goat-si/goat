import {
  botArtifactCardReadsFirstChunk,
  botArtifactName,
  botArtifactPreview,
  botArtifactPreviewSlot,
  botArtifactViewKind,
  botFileReads,
  goatBotReplyFiles,
  goatBotReplyMayNameFile,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelBotArtifact, EnvironmentId } from "@goat/contracts";
import { createContext, memo, use, useEffect, useEffectEvent, useState } from "react";

import { FileIcon, FileTextIcon, ImageIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
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
  /** The read failed, was skipped, or gave nothing to show; the card still opens. */
  | { readonly kind: "unavailable" }
  | null;

const UNAVAILABLE: Preview = { kind: "unavailable" };

/**
 * Rereads of one Library listing, shared by every reply that reads it: one read in flight; a reply
 * that needs a read while one runs owes one follow-up when it settles; a failure clears what is
 * owed, so a later reply tries again. Replies that ask in the same tick share one read.
 */
interface ListingRereads {
  running: boolean;
  owed: boolean;
  scheduled: boolean;
  /** The answer the running read started from; any other settled answer means it settled. */
  startedFrom: unknown;
}
const rereads = new WeakMap<object, ListingRereads>();
const sameResult = <Result,>(result: Result) => result;

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
  const query = wanted ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null;
  const listing = useEnvironmentQuery(query);
  const result = useEnvironmentQuerySelector(query, sameResult);
  const settled = result.waiting || result._tag === "Initial" ? null : result;
  const start = (state: ListingRereads, from: unknown) => {
    state.running = true;
    state.owed = false;
    state.startedFrom = from;
    listing.refresh();
  };
  // A listing already read once may predate the file this reply names; a first read still out
  // covers it.
  const ask = useEffectEvent((listingQuery: object) => {
    if (result._tag === "Initial") return;
    const state = rereads.get(listingQuery) ?? {
      running: false,
      owed: false,
      scheduled: false,
      startedFrom: null,
    };
    rereads.set(listingQuery, state);
    if (state.running) state.owed = true;
    if (state.running || state.scheduled) return;
    state.scheduled = true;
    const from = result;
    queueMicrotask(() => {
      state.scheduled = false;
      if (state.running) state.owed = true;
      else start(state, from);
    });
  });
  const settle = useEffectEvent((listingQuery: object, answer: typeof result) => {
    const state = rereads.get(listingQuery);
    if (state === undefined || !state.running || answer === state.startedFrom) return;
    state.running = false;
    if (answer._tag === "Failure") state.owed = false;
    else if (state.owed) start(state, answer);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- The Library lives on the server and nothing tells this client a file was saved; a reply that comes to name one asks for a reread when it first wants the listing.
  useEffect(() => {
    if (query !== null) ask(query);
  }, [query]);
  // oxlint-disable-next-line goat/react-effect-budget -- A reread settles on the server's time; then the follow-up a reply owed, if any, starts.
  useEffect(() => {
    if (query !== null && settled !== null) settle(query, settled);
  }, [query, settled]);
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
  // A card with no preview to draw is named from the file's name and reads nothing.
  const readsFirstChunk = botArtifactCardReadsFirstChunk(file.relativePath, file.size);
  const read = useAtomCommand(channelEnvironment.readBotArtifact, { reportFailure: false });
  const [preview, setPreview] = useState<Preview>(null);
  const readFirstChunk = useEffectEvent(() =>
    botFileReads.preview(
      environmentId,
      async (input) => {
        const answer = await read({ environmentId, input });
        if (answer._tag === "Failure") throw squashAtomCommandFailure(answer);
        return answer.value;
      },
      file.relativePath,
    ),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- The first chunk arrives after render; a card that goes leaves the queue and lets its image URL go.
  useEffect(() => {
    if (!readsFirstChunk) return;
    let cancelled = false;
    let url: string | null = null;
    const pending = readFirstChunk();
    void pending.result.then((outcome) => {
      if (cancelled || outcome.status === "cancelled") return;
      const next = outcome.status === "ready" ? botArtifactPreview(outcome.answer) : null;
      if (next === null) setPreview(UNAVAILABLE);
      else if (next.kind === "image") {
        url = URL.createObjectURL(new Blob([next.bytes], { type: next.mimeType }));
        setPreview({ kind: "image", url });
      } else setPreview(next);
    });
    return () => {
      cancelled = true;
      pending.cancel();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [readsFirstChunk]);
  const shown = preview === null || preview.kind === "unavailable" ? kind : preview.kind;
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
              preview.kind !== "unavailable" &&
              "px-4 pt-3 text-xs [mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
            preview?.kind === "unavailable" && "px-4 pt-3",
          )}
        >
          {preview?.kind === "image" ? (
            <img src={preview.url} alt="" className="size-full object-cover" />
          ) : preview?.kind === "unavailable" ? (
            <span className="text-xs text-muted-foreground">Preview unavailable</span>
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
