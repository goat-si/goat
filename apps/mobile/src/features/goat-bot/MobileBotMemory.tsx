import {
  botNotesFailure,
  changeNoteDraft,
  forgetNoteDraft,
  GOAT_BOT_NOTES_COPY,
  GOAT_BOT_NOTES_SHARED_COPY,
  GOAT_BOT_NOTES_TRUNCATED_COPY,
  goatBotNoteSourceLabel,
  goatBotNotesView,
  noteDateLabel,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotNote, EnvironmentId } from "@goat/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

/** GOAT Bot's notes, read only; changing or forgetting one is a message the person sends. */
export function MobileBotMemory(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly supported: boolean;
  /** A member bot's sheet, which shows the same notes as the main bot's. */
  readonly member: boolean;
  readonly botName?: string;
  /** Puts a message in the chat's composer; absent while the chat cannot send. */
  readonly onDraft?: ((text: string) => void) | undefined;
  /** Changes when the bot answers or a task moves on, which may have changed the notes. */
  readonly refreshKey?: string | undefined;
}) {
  const { environmentId, connected, supported, onDraft } = props;
  const botName = props.botName ?? "GOAT Bot";
  const readable = environmentId !== null && connected && supported;
  const notes = useEnvironmentQuery(
    readable ? channelEnvironment.listBotNotes({ environmentId, input: {} }) : null,
  );
  const refresh = notes.refresh;
  // Null while there is nothing to read; otherwise the latest answer or task change.
  const trigger = readable ? (props.refreshKey ?? "") : null;
  // oxlint-disable-next-line goat/react-effect-budget -- The notes file lives on the server: read it again when the tab opens and after each answer, since a task may have changed it.
  useEffect(() => {
    if (trigger !== null) refresh();
  }, [trigger, refresh]);
  const failure = notes.cause === null ? null : botNotesFailure(notes.cause, botName);
  return (
    <View className="gap-3 py-2">
      <Text className="text-foreground-muted">{GOAT_BOT_NOTES_COPY}</Text>
      {props.member ? (
        <Text className="text-foreground-muted">{GOAT_BOT_NOTES_SHARED_COPY}</Text>
      ) : null}
      {!connected ? (
        <Text className="text-foreground-muted">
          Notes are unavailable while {botName} is offline.
        </Text>
      ) : !supported ? (
        <Text className="text-foreground-muted">Notes need a newer GOAT server.</Text>
      ) : failure !== null ? (
        <View className="gap-1">
          <Text className="text-danger-foreground">{failure.message}</Text>
          {failure.retry ? (
            <Pressable
              accessibilityRole="button"
              onPress={refresh}
              className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
            >
              <Text className="text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : notes.data === null ? (
        <Text className="text-foreground-muted">Loading notes…</Text>
      ) : (
        <MobileNoteList
          revision={notes.data.revision}
          notes={notes.data.notes}
          truncated={notes.data.truncated}
          onDraft={onDraft}
          botName={botName}
        />
      )}
    </View>
  );
}

function MobileNoteList(props: {
  readonly revision: string | null;
  readonly notes: ReadonlyArray<ChannelBotNote>;
  readonly truncated: boolean;
  readonly onDraft: ((text: string) => void) | undefined;
  readonly botName: string;
}) {
  const view = goatBotNotesView({ notes: props.notes, truncated: props.truncated });
  const [showReplaced, setShowReplaced] = useState(false);
  const now = useNowMinuteMs();
  return (
    <View className="gap-1">
      {props.truncated ? (
        <Text className="text-foreground-muted">{GOAT_BOT_NOTES_TRUNCATED_COPY}</Text>
      ) : null}
      {view.empty === "none" ? (
        <MobileBotPanelEmpty
          title="No notes yet"
          next={`Ask ${props.botName} to remember a standing rule.`}
        />
      ) : view.empty === "none_in_window" ? (
        <Text className="text-foreground-muted">
          No complete note fits in the newest 64 KB of memory.md.
        </Text>
      ) : view.empty === "no_current" ? (
        <Text className="text-foreground-muted">No current notes.</Text>
      ) : (
        view.current.map((note) => (
          // An index is a line's place in this read only, so a new read starts every row over.
          <MobileNoteRow
            key={`${props.revision}:${note.index}`}
            note={note}
            source={goatBotNoteSourceLabel(note.source, { now })}
            onDraft={props.onDraft}
          />
        ))
      )}
      {view.replaced.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showReplaced }}
          onPress={() => setShowReplaced((value) => !value)}
          className="min-h-[44px] min-w-[44px] justify-center px-2"
        >
          <Text className="text-foreground">
            {showReplaced ? "Hide replaced notes" : `Show replaced notes (${view.replaced.length})`}
          </Text>
        </Pressable>
      ) : null}
      {showReplaced
        ? view.replaced.map((note) => {
            const replacing = view.replacingText(note);
            const source = goatBotNoteSourceLabel(note.source, { now });
            return (
              <View
                key={`${props.revision}:${note.index}`}
                className="gap-1 border-b border-border py-2"
              >
                <Text className="text-foreground-muted">{noteDateLabel(note)}</Text>
                {source !== null ? <Text className="text-foreground-muted">{source}</Text> : null}
                <Text className="text-foreground-muted">{note.text}</Text>
                <Text className="text-foreground-muted">
                  {replacing === null ? "Replaced by a later note" : `Replaced by: “${replacing}”`}
                </Text>
              </View>
            );
          })
        : null}
    </View>
  );
}

function MobileNoteRow(props: {
  readonly note: ChannelBotNote;
  readonly source: string | null;
  readonly onDraft: ((text: string) => void) | undefined;
}) {
  const { note, onDraft } = props;
  const [wording, setWording] = useState<string | null>(null);
  const draft = wording === null ? null : changeNoteDraft(note, wording);
  const canAsk = onDraft !== undefined;
  return (
    <View className="gap-1 border-b border-border py-2">
      <Text className="text-foreground-muted">{noteDateLabel(note)}</Text>
      {props.source !== null ? <Text className="text-foreground-muted">{props.source}</Text> : null}
      <Text className="text-foreground">{note.text}</Text>
      {note.replaces !== undefined ? (
        <Text className="text-foreground-muted">Replaces: “{note.replaces}”</Text>
      ) : null}
      {wording === null ? (
        <View className="flex-row flex-wrap gap-x-4">
          <Pressable
            accessibilityRole="button"
            disabled={!canAsk}
            onPress={() => setWording(note.text)}
            className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
          >
            <Text className={canAsk ? "text-foreground" : "text-foreground-muted"}>
              Ask to change
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!canAsk}
            onPress={() => onDraft?.(forgetNoteDraft(note))}
            className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
          >
            <Text className={canAsk ? "text-foreground" : "text-foreground-muted"}>
              Ask to forget
            </Text>
          </Pressable>
        </View>
      ) : (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="New wording"
            value={wording}
            onChangeText={setWording}
            multiline
            className="min-h-[44px] rounded-md border border-border px-3 py-2 text-foreground"
          />
          <View className="flex-row flex-wrap gap-x-4">
            <Pressable
              accessibilityRole="button"
              disabled={draft === null || !canAsk}
              onPress={() => {
                if (draft === null) return;
                onDraft?.(draft);
                setWording(null);
              }}
              className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
            >
              <Text className={draft === null ? "text-foreground-muted" : "text-foreground"}>
                Fill message
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setWording(null)}
              className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
            >
              <Text className="text-foreground">Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
