import {
  botArtifactName,
  botArtifactPreviewSlot,
  botArtifactViewKind,
  goatBotReplyFiles,
} from "@goat/client-runtime/goatBot";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import type { ChannelBotArtifact, EnvironmentId, ThreadId } from "@goat/contracts";
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
import { queuePreviewRead } from "./goatBotFileReads";
import {
  cachedGoatBotFilePreview,
  goatBotFilePreviewOf,
  listingGeneration,
  storeGoatBotFilePreview,
  type GoatBotFilePreview,
  type GoatBotPreviewBlock,
} from "./goatBotFilePreview";
import { useBotFileOpener } from "./MobileBotFileViewer";

interface GoatBotFiles {
  readonly environmentId: EnvironmentId;
  /** The chat these cards belong to; a read for another chat never lands. */
  readonly chatKey: string;
  readonly artifacts: ReadonlyArray<ChannelBotArtifact> | null;
  readonly generation: number;
  readonly ask: (occurrences: ReadonlyArray<string>) => void;
  readonly open: (file: ChannelBotArtifact) => void;
  readonly opening: string | null;
  readonly messages: Readonly<Record<string, string>>;
}

const GoatBotFilesContext = createContext<GoatBotFiles | null>(null);

/**
 * The chat's Library: its listing, read when the chat opens and again for each newly named file,
 * and the one viewer its file cards open. No cards on a server without the Library or offline.
 */
export function GoatBotFilesProvider(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly botName: string;
  readonly children: ReactNode;
}) {
  const { environmentId } = props;
  const { presentationById } = useEnvironments();
  const presentation = environmentId === null ? undefined : presentationById.get(environmentId);
  const readable =
    environmentId !== null &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotLibrary === true;
  const listing = useEnvironmentQuery(
    readable ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null,
  );
  const opener = useBotFileOpener(environmentId, props.botName);
  const refresh = listing.refresh;
  const chatKey = JSON.stringify([environmentId, props.threadId]);
  // Every newly seen occurrence is owed a listing read that starts after it was seen: one read at
  // a time, and one follow-up for those that arrived while a read was running. A new chat starts
  // with nothing seen.
  const reads = useRef({ chatKey, running: false, dirty: false, seen: new Set<string>() });
  const stateFor = useCallback(() => {
    if (reads.current.chatKey !== chatKey)
      reads.current = { chatKey, running: false, dirty: false, seen: new Set<string>() };
    return reads.current;
  }, [chatKey]);
  const ask = useCallback(
    (occurrences: ReadonlyArray<string>) => {
      if (!readable) return;
      const state = stateFor();
      const fresh = occurrences.filter((occurrence) => !state.seen.has(occurrence));
      if (fresh.length === 0) return;
      for (const occurrence of fresh) state.seen.add(occurrence);
      if (state.running) {
        state.dirty = true;
        return;
      }
      state.running = true;
      refresh();
    },
    [readable, refresh, stateFor],
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Files are saved on the server at any time; read the listing again when the chat opens.
  useEffect(() => {
    const state = stateFor();
    if (!readable || state.running) return;
    state.running = true;
    refresh();
  }, [readable, refresh, stateFor]);
  const pending = listing.isPending;
  const answer = listing.data;
  const failure = listing.error;
  // oxlint-disable-next-line goat/react-effect-budget -- A listing read settles on the server's time; then the follow-up read, if one is owed, starts.
  useEffect(() => {
    const state = stateFor();
    // Settled: no longer waiting, with an answer or a failure to show for it.
    if (pending || !state.running || (answer === null && failure === null)) return;
    state.running = false;
    if (!state.dirty) return;
    state.dirty = false;
    state.running = true;
    refresh();
  }, [pending, answer, failure, refresh, stateFor]);
  const artifacts = readable && failure === null ? (answer?.artifacts ?? null) : null;
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
            generation,
            ask,
            open: (file: ChannelBotArtifact) => void open(file),
            opening,
            messages,
          },
    [environmentId, chatKey, artifacts, generation, ask, open, opening, messages],
  );
  return (
    <GoatBotFilesContext value={value}>
      {props.children}
      {viewer}
    </GoatBotFilesContext>
  );
}

const INLINE_CODE = /`([^`\n]+)`/g;

/** A reply's inline-code spans, each a possible file name; the listing decides which are. */
function inlineCodeSpans(text: string): ReadonlyArray<string> {
  return [...text.matchAll(INLINE_CODE)].flatMap((match) => {
    const span = (match[1] ?? "").trim();
    return span === "" ? [] : [span];
  });
}

/** Cards under a bot message for each Library file it names, in the order named. */
export const GoatBotReplyFiles = memo(function GoatBotReplyFiles(props: {
  readonly rowId: string;
  readonly text: string;
}) {
  const files = use(GoatBotFilesContext);
  const occurrences = useMemo(
    () =>
      inlineCodeSpans(props.text).map((span, index) => JSON.stringify([props.rowId, index, span])),
    [props.rowId, props.text],
  );
  const ask = files?.ask;
  // oxlint-disable-next-line goat/react-effect-budget -- A newly named file may have been saved after the listing was read; ask the chat to read it again.
  useEffect(() => {
    if (ask !== undefined && occurrences.length > 0) ask(occurrences);
  }, [ask, occurrences]);
  const artifacts = files?.artifacts ?? null;
  const named = useMemo(
    () => (artifacts === null ? [] : goatBotReplyFiles(props.text, artifacts)),
    [artifacts, props.text],
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
  const cached = cachedGoatBotFilePreview(environmentId, path, generation);
  const [read, setRead] = useState<{
    readonly key: string;
    readonly preview: GoatBotFilePreview | null;
  } | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- The first chunk arrives after render; a card that goes, or changes chat or listing, leaves the queue and drops a late answer.
  useEffect(() => {
    if (cached !== undefined) return;
    let stale = false;
    const pending = queuePreviewRead(environmentId, () =>
      runAtomCommand(
        appAtomRegistry,
        channelEnvironment.readBotArtifact,
        { environmentId, input: { relativePath: path } },
        { label: "GOAT Bot file preview", reportFailure: false },
      ),
    );
    void pending.result.then(
      (answer) => {
        if (stale || answer === null || answer._tag !== "Success") return;
        const next = goatBotFilePreviewOf(answer.value);
        if (next !== null) storeGoatBotFilePreview(environmentId, path, generation, next);
        setRead({ key, preview: next });
      },
      () => {},
    );
    return () => {
      stale = true;
      pending.cancel();
    };
  }, [cached, environmentId, path, generation, key]);
  const preview = cached ?? (read?.key === key ? read.preview : null);
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
        accessibilityLabel={`Open ${name}`}
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
            <GoatBotFilePreviewView preview={preview} />
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

function GoatBotFilePreviewView(props: { readonly preview: GoatBotFilePreview | null }) {
  const label = useScaledTextRole("label");
  const { preview } = props;
  if (preview === null) return <View className="flex-1" />;
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
