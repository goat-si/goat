import {
  botArtifactName,
  botArtifactPreviewSlot,
  botArtifactViewKind,
  botFileReads,
  goatBotReplyFiles,
  goatBotReplyMayNameFile,
} from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  ChannelBotArtifact,
  ChannelReadBotArtifactInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Image, Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  cachedGoatBotFilePreview,
  forgetChatFilePreviews,
  goatBotFilePreviewOf,
  listingGeneration,
  storeGoatBotFilePreview,
  type GoatBotFilePreview,
  type GoatBotPreviewBlock,
} from "./goatBotFilePreview";
import type { useBotFileOpener } from "./MobileBotFileViewer";

interface GoatBotFiles {
  readonly environmentId: EnvironmentId;
  /** The chat these cards belong to; a read for another chat never lands. */
  readonly chatKey: string;
  readonly artifacts: ReadonlyArray<ChannelBotArtifact> | null;
  /** The listing's artifacts folder; without it a full path names no file. */
  readonly root: string | undefined;
  readonly generation: number;
  readonly open: (file: ChannelBotArtifact) => void;
  readonly opening: string | null;
  readonly messages: Readonly<Record<string, string>>;
}

/** A bot reply as the chat's file cards need it. */
export interface GoatBotFilesReply {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  /** Still arriving: it asks for no listing until it has finished. */
  readonly streaming: boolean;
}

const GoatBotFilesContext = createContext<GoatBotFiles | null>(null);

interface ListingReads {
  readonly chatKey: string;
  running: boolean;
  /** A finished reply asked while a read ran: one follow-up read when it settles. */
  dirty: boolean;
  /** The settled answer a running read started from; another one means it settled. */
  startedFrom: unknown;
  /** Finished replies already decided, by id with the text decided on, and replies seen streaming. */
  readonly decided: Map<string, string>;
  readonly streamed: Set<string>;
  /** The newest finished reply a read has started after; older history needs no read. */
  coveredUpTo: string | null;
  latestFinished: string | null;
}

const freshReads = (chatKey: string): ListingReads => ({
  chatKey,
  running: false,
  dirty: false,
  startedFrom: null,
  decided: new Map(),
  streamed: new Set(),
  coveredUpTo: null,
  latestFinished: null,
});

export type GoatBotFileOpener = ReturnType<typeof useBotFileOpener>;

/** What a chat's file opener and previews belong to: its environment and conversation thread. */
export const chatFilesScope = (environmentId: EnvironmentId | null, threadId: ThreadId | null) =>
  JSON.stringify([environmentId, threadId]);

/**
 * The chat's Library: its listing, read once a finished reply names something (one read for every
 * reply that finishes while none runs, one follow-up for those that finish during a read), and the
 * viewer of the opener its owner passes in. No cards on a server without the Library or offline.
 */
export function GoatBotFilesProvider(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly replies: ReadonlyArray<GoatBotFilesReply>;
  /** The chat's opener, scoped to `chatFilesScope` of this environment and thread. */
  readonly opener: GoatBotFileOpener;
  readonly children: ReactNode;
}) {
  const { environmentId, replies, opener } = props;
  const { presentationById } = useEnvironments();
  const presentation = environmentId === null ? undefined : presentationById.get(environmentId);
  const readable =
    environmentId !== null &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotLibrary === true;
  const listing = useEnvironmentQuery(
    readable ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null,
  );
  const chatKey = chatFilesScope(environmentId, props.threadId);
  const refresh = listing.refresh;
  const pending = listing.isPending;
  // What a read settles to: an answer or a failure, never the answer it started from.
  const settled = pending ? null : (listing.successResult ?? listing.cause);
  const reads = useRef<ListingReads | null>(null);
  const stateFor = useCallback(() => {
    if (reads.current?.chatKey !== chatKey) reads.current = freshReads(chatKey);
    return reads.current;
  }, [chatKey]);
  const start = useCallback(
    (state: ListingReads, from: unknown) => {
      state.running = true;
      state.dirty = false;
      state.startedFrom = from;
      state.coveredUpTo = state.latestFinished;
      refresh();
    },
    [refresh],
  );
  // oxlint-disable-next-line goat/react-effect-budget -- A finished reply may name a file saved after the listing was read; read it again, once per finished reply.
  useEffect(() => {
    if (!readable) return;
    const state = stateFor();
    let owed = false;
    for (const reply of replies) {
      if (reply.streaming) {
        state.streamed.add(reply.id);
        continue;
      }
      const before = state.decided.get(reply.id);
      if (before === reply.text) continue;
      state.decided.set(reply.id, reply.text);
      // A finished reply whose words changed is new to any read, like one that streamed.
      if (before !== undefined) state.streamed.add(reply.id);
      const older = state.coveredUpTo !== null && reply.createdAt <= state.coveredUpTo;
      if (state.latestFinished === null || reply.createdAt > state.latestFinished)
        state.latestFinished = reply.createdAt;
      if (!goatBotReplyMayNameFile(reply.text)) continue;
      // History older than a reply a read already started after: that read saw its files.
      if (older && !state.streamed.has(reply.id)) continue;
      owed = true;
    }
    if (!owed) return;
    if (state.running) state.dirty = true;
    else start(state, settled);
  }, [readable, replies, settled, stateFor, start]);
  // oxlint-disable-next-line goat/react-effect-budget -- A listing read settles on the server's time; then the follow-up read, if one is owed, starts.
  useEffect(() => {
    const state = stateFor();
    if (!state.running || settled === null || settled === state.startedFrom) return;
    state.running = false;
    if (state.dirty) start(state, settled);
  }, [settled, stateFor, start]);
  // oxlint-disable-next-line goat/react-effect-budget -- Previews outlive a render; leaving the chat drops its waiting reads and its cached previews.
  useEffect(
    () => () => {
      botFileReads.leaveChat(chatKey);
      forgetChatFilePreviews(chatKey);
    },
    [chatKey],
  );
  const answer = listing.data;
  const failure = listing.error;
  const artifacts = readable && failure === null ? (answer?.artifacts ?? null) : null;
  const root = readable && failure === null ? answer?.root : undefined;
  const generation = answer === null ? 0 : listingGeneration(answer);
  const { open, opening, messages, viewer } = opener;
  const value = useMemo(
    () =>
      environmentId === null
        ? null
        : {
            environmentId,
            chatKey,
            artifacts,
            root,
            generation,
            open: (file: ChannelBotArtifact) => void open(file),
            opening,
            messages,
          },
    [environmentId, chatKey, artifacts, root, generation, open, opening, messages],
  );
  return (
    <GoatBotFilesContext value={value}>
      {props.children}
      {viewer}
    </GoatBotFilesContext>
  );
}

/** Cards under a bot message for each Library file it names, in the order named. */
export const GoatBotReplyFiles = memo(function GoatBotReplyFiles(props: { readonly text: string }) {
  const files = use(GoatBotFilesContext);
  const artifacts = files?.artifacts ?? null;
  const root = files?.root;
  const named = useMemo(
    () => (artifacts === null ? [] : goatBotReplyFiles(props.text, artifacts, root)),
    [artifacts, root, props.text],
  );
  if (files === null || named.length === 0) return null;
  return (
    <View className="gap-2">
      {named.map((file) => (
        <GoatBotFileCard
          key={`${file.relativePath}:${file.modifiedAt}`}
          files={files}
          file={file}
        />
      ))}
    </View>
  );
});

const KIND_LABEL = { markdown: "Document", text: "Text", image: "Image", download: "File" };
const KIND_SPOKEN = {
  markdown: "Markdown file",
  text: "Text file",
  image: "Image",
  download: "File",
};
const KIND_SYMBOL = {
  markdown: "doc.text",
  text: "doc.text",
  image: "photo",
  download: "doc",
} as const;
const SLOT_HEIGHT = { image: 160, text: 120 };

function GoatBotFileCard(props: {
  readonly files: GoatBotFiles;
  readonly file: ChannelBotArtifact;
}) {
  const { files, file } = props;
  const { environmentId, chatKey, generation } = files;
  const path = file.relativePath;
  const name = botArtifactName(path);
  const label = useScaledTextRole("label");
  const key = JSON.stringify([chatKey, path, generation]);
  const cached = cachedGoatBotFilePreview(chatKey, path, generation);
  const [read, setRead] = useState<{
    readonly key: string;
    readonly preview: GoatBotFilePreview | null;
  } | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- The first chunk arrives after render; a card that goes, or changes chat or listing, leaves the queue and drops a late answer.
  useEffect(() => {
    if (cached !== undefined) return;
    let stale = false;
    const readChunk = async (input: ChannelReadBotArtifactInput) => {
      const answer = await runAtomCommand(
        appAtomRegistry,
        channelEnvironment.readBotArtifact,
        { environmentId, input },
        { label: "GOAT Bot file preview", reportFailure: false },
      );
      if (answer._tag === "Failure") throw squashAtomCommandFailure(answer);
      return answer.value;
    };
    const pending = botFileReads.preview(environmentId, readChunk, path, chatKey);
    void pending.result.then((outcome) => {
      if (stale || outcome.status === "cancelled") return;
      const next = outcome.status === "ready" ? goatBotFilePreviewOf(outcome.answer) : null;
      // A preview, or nothing to show in this version of the file, is kept; a failed, skipped,
      // changed or invalid read is asked again on the next mount.
      const stable =
        outcome.status === "ready" &&
        (outcome.answer.status === "chunk" || outcome.answer.status === "too_large");
      if (next !== null || stable) storeGoatBotFilePreview(chatKey, path, generation, next);
      setRead({ key, preview: next });
    });
    return () => {
      stale = true;
      pending.cancel();
    };
  }, [cached, environmentId, chatKey, path, generation, key]);
  const preview = cached ?? (read?.key === key ? read.preview : null);
  const unavailable =
    cached === null || (cached === undefined && read?.key === key && read.preview === null);
  const slot = botArtifactPreviewSlot(path, file.size);
  // Before or without a preview, an image name still reads as an image.
  const kind =
    preview?.kind ?? (slot === "image" ? "image" : botArtifactViewKind("", path, file.size));
  const opening = files.opening === path;
  const message = files.messages[path];
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}, ${KIND_SPOKEN[kind]}`}
        accessibilityState={{ disabled: files.opening !== null, busy: opening }}
        disabled={files.opening !== null}
        onPress={() => files.open(file)}
        className="overflow-hidden rounded-2xl border border-border bg-grouped-card"
      >
        {/* The room is kept before the file is read, so the list does not move when it arrives. */}
        {slot !== null ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="overflow-hidden"
            style={{ height: SLOT_HEIGHT[slot] }}
          >
            <GoatBotFilePreviewView preview={preview} unavailable={unavailable} />
          </View>
        ) : null}
        <View
          className={`min-h-[44px] flex-row items-center gap-2.5 px-3 py-2${slot !== null ? " border-t border-border" : ""}`}
        >
          <SymbolView name={KIND_SYMBOL[kind]} size={18} tintColorClassName="accent-icon-muted" />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} ellipsizeMode="middle" className="font-medium text-foreground">
              {name}
            </Text>
            <Text className="text-foreground-muted" style={label}>
              {opening ? "Opening…" : KIND_LABEL[kind]}
            </Text>
          </View>
        </View>
      </Pressable>
      {message ? <Text className="text-danger-foreground">{message}</Text> : null}
    </View>
  );
}

function GoatBotFilePreviewView(props: {
  readonly preview: GoatBotFilePreview | null;
  readonly unavailable: boolean;
}) {
  const label = useScaledTextRole("label");
  const { preview } = props;
  if (preview === null)
    return (
      <View className="flex-1 justify-center px-3">
        {props.unavailable ? (
          <Text className="text-foreground-muted" style={label}>
            Preview unavailable
          </Text>
        ) : null}
      </View>
    );
  if (preview.kind === "image")
    return (
      <Image
        source={{ uri: preview.uri }}
        resizeMode="cover"
        resizeMethod="resize"
        style={{ width: "100%", height: "100%" }}
      />
    );
  if (preview.kind === "text")
    return (
      <Text className="px-3 pt-2 font-mono text-foreground-muted" style={label}>
        {preview.text}
      </Text>
    );
  return (
    <View className="gap-1 px-3 pt-2">
      {preview.blocks.map((block, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- blocks are positional and never reorder
        <GoatBotPreviewBlockView key={index} block={block} />
      ))}
    </View>
  );
}

function GoatBotPreviewBlockView(props: { readonly block: GoatBotPreviewBlock }) {
  const label = useScaledTextRole("label");
  const { block } = props;
  return (
    <Text
      className={
        block.kind === "heading"
          ? "font-semibold text-foreground"
          : block.kind === "code"
            ? "font-mono text-foreground-muted"
            : "text-foreground-muted"
      }
      style={label}
    >
      {block.kind === "item" ? "• " : block.kind === "quote" ? "│ " : ""}
      {block.inlines.map((inline, index) => (
        <Text
          // oxlint-disable-next-line react/no-array-index-key -- runs are positional and never reorder
          key={index}
          className={[
            inline.strong ? "font-semibold" : "",
            inline.emphasis ? "italic" : "",
            inline.code ? "font-mono" : "",
          ].join(" ")}
        >
          {inline.text}
        </Text>
      ))}
    </Text>
  );
}
