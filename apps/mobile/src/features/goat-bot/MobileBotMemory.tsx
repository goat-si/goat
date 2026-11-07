import {
  botNotesFailure,
  changeNoteDraft,
  forgetNoteDraft,
  GOAT_BOT_NOTES_COPY,
  GOAT_BOT_NOTES_SHARED_COPY,
  noteDateLabel,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotNote, EnvironmentId } from "@goat/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";

/** GOAT Bot's notes, read only; changing or forgetting one is a message the person sends. */
export function MobileBotMemory(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly supported: boolean;
  /** A member bot's sheet, which shows the same notes as the main bot's. */
  readonly member: boolean;
  /** Puts a message in the chat's composer; absent while the chat cannot send. */
  readonly onDraft?: ((text: string) => void) | undefined;
  /** Changes when the bot answers or a task moves on, which may have changed the notes. */
  readonly refreshKey?: string | undefined;
}) {
  const { environmentId, connected, supported, onDraft } = props;
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
  const failure = notes.cause === null ? null : botNotesFailure(notes.cause);
  return (
    <View className="gap-3 py-2">
      <Text className="text-foreground-muted">{GOAT_BOT_NOTES_COPY}</Text>
      {props.member ? (
        <Text className="text-foreground-muted">{GOAT_BOT_NOTES_SHARED_COPY}</Text>
      ) : null}
      {!connected ? (
        <Text className="text-foreground-muted">
          Notes are unavailable while GOAT Bot is offline.
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
              className="min-h-[44px] justify-center"
            >
              <Text className="text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : notes.data === null ? (
        <Text className="text-foreground-muted">Loading notes…</Text>
      ) : notes.data.notes.length === 0 ? (
        <Text className="text-foreground-muted">
          No notes yet. Ask GOAT Bot to remember a standing rule.
        </Text>
      ) : (
        <View className="gap-1">
          {notes.data.truncated ? (
            <Text className="text-foreground-muted">Showing the newest notes only.</Text>
          ) : null}
          {notes.data.notes.map((note) => (
            <MobileNoteRow key={note.index} note={note} onDraft={onDraft} />
          ))}
        </View>
      )}
    </View>
  );
}

function MobileNoteRow(props: {
  readonly note: ChannelBotNote;
  readonly onDraft: ((text: string) => void) | undefined;
}) {
  const { note, onDraft } = props;
  const [wording, setWording] = useState<string | null>(null);
  const draft = wording === null ? null : changeNoteDraft(note, wording);
  const canAsk = onDraft !== undefined;
  return (
    <View className="gap-1 border-b border-border py-2">
      <Text className="text-foreground-muted">{noteDateLabel(note.date)}</Text>
      <Text className="text-foreground">{note.text}</Text>
      {wording === null ? (
        <View className="flex-row gap-4">
          <Pressable
            accessibilityRole="button"
            disabled={!canAsk}
            onPress={() => setWording(note.text)}
            className="min-h-[44px] justify-center"
          >
            <Text className={canAsk ? "text-foreground" : "text-foreground-muted"}>
              Ask to change
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!canAsk}
            onPress={() => onDraft?.(forgetNoteDraft(note))}
            className="min-h-[44px] justify-center"
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
          <View className="flex-row gap-4">
            <Pressable
              accessibilityRole="button"
              disabled={draft === null || !canAsk}
              onPress={() => {
                if (draft === null) return;
                onDraft?.(draft);
                setWording(null);
              }}
              className="min-h-[44px] justify-center"
            >
              <Text className={draft === null ? "text-foreground-muted" : "text-foreground"}>
                Fill message
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setWording(null)}
              className="min-h-[44px] justify-center"
            >
              <Text className="text-foreground">Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
