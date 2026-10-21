import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type NoteDocument, type NoteStatus } from "@goat/contracts";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { Button } from "../../components/ui/Button";
import { applyNoteCheckboxEvent, type NoteCheckboxEvent } from "./note-markdown";
import { NoteLinkedThread } from "./NoteLinkedThread";
import { noteSyncLabel, noteSyncState } from "./notes-model";
import { notesRpc } from "./rpc/notes";
import {
  flushNotes,
  notesCommandOptions,
  notesError,
  notesOutbox,
  useNotesFeed,
  useNotesOutbox,
  useNoteDraftAccess,
} from "./notes-state";

type NoteParams = { environmentId: string; path: string; create?: boolean };
export function NoteRouteScreen({ route }: StaticScreenProps<NoteParams>) {
  return (
    <NoteContent
      key={JSON.stringify([route.params.environmentId, route.params.path])}
      {...route.params}
    />
  );
}

function NoteContent(props: NoteParams) {
  const environmentId = EnvironmentId.make(props.environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const feed = useNotesFeed(environmentId);
  const rows = useNotesOutbox();
  const row = rows.find(
    (entry) => entry.environmentId === environmentId && entry.path === props.path,
  );
  const { canEdit: canWrite, canStart, connected } = useNoteDraftAccess(environmentId);
  const read = useAtomCommand(notesRpc.read, notesCommandOptions);
  const [note, setNote] = useState<NoteDocument | null>(row?.current ?? null);
  const [body, setBody] = useState(row?.body ?? "");
  // An acknowledgement can remove the outbox row while this editor still owns newer text.
  const [hasSnapshot, setHasSnapshot] = useState(Boolean(row) || Boolean(props.create));
  const [status, setStatus] = useState<NoteStatus>(row?.status ?? "idea");
  const [editing, setEditing] = useState(Boolean(props.create));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkboxRender, setCheckboxRender] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const previousRow = useRef(row);
  const [reload, setReload] = useState(0);
  const readRequest = useMemo(
    () => ({ environmentId, input: { path: props.path }, refresh: reload }),
    [environmentId, props.path, reload],
  );
  const editBase = useRef<string | null>(row?.baseRevision ?? null);
  const localBody = useRef(body);
  const localStatus = useRef(status);
  const pendingSaves = useRef(0);
  const latest = Option.getOrNull(AsyncResult.value(feed))?.notes.find(
    (entry) => entry.path === props.path,
  );
  usePreventRemove(dirty || saving, ({ data }) => {
    if (saving) return;
    Alert.alert("Unsaved note", "Save your edits on this phone before leaving, or discard them.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard edits",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  useEffect(() => {
    let active = true;
    void notesOutbox
      .restore()
      .then(() => {
        if (active) setRestored(true);
        const restored = notesOutbox
          .getSnapshot()
          .find((entry) => entry.environmentId === environmentId && entry.path === props.path);
        if (active && restored) {
          setHasSnapshot(true);
          setBody(restored.body);
          localBody.current = restored.body;
          setStatus(restored.status ?? "idea");
          localStatus.current = restored.status ?? "idea";
          editBase.current = restored.baseRevision;
        }
      })
      .catch((error: unknown) => {
        if (active) setError(notesError(error));
      });
    return () => {
      active = false;
    };
  }, [environmentId, props.path]);
  useEffect(() => {
    if (!restored || !connected || row || editing || saving || dirty || (props.create && !latest))
      return;
    let active = true;
    void read({ environmentId: readRequest.environmentId, input: readRequest.input }).then(
      (result) => {
        if (!active) return;
        if (AsyncResult.isSuccess(result)) {
          setHasSnapshot(true);
          setNote(result.value);
          setBody(result.value.body);
          localBody.current = result.value.body;
          setStatus(result.value.status);
          localStatus.current = result.value.status;
          editBase.current = result.value.revision;
          setError(null);
        } else if (AsyncResult.isFailure(result)) setError(notesError(Cause.squash(result.cause)));
      },
    );
    return () => {
      active = false;
    };
  }, [readRequest, props.create, latest, row, editing, saving, dirty, read, restored, connected]);
  useEffect(() => {
    const before = previousRow.current;
    previousRow.current = row;
    if (before?.state === "conflict" && before.current && !row && !editing && !dirty && !saving) {
      setNote(before.current);
      setBody(before.current.body);
      localBody.current = before.current.body;
      setStatus(before.current.status);
      localStatus.current = before.current.status;
      editBase.current = before.current.revision;
    }
  }, [row, editing, dirty, saving]);

  const save = async (nextBody: string, nextStatus: NoteStatus) => {
    if (!canWrite) return;
    setSaving(true);
    pendingSaves.current++;
    setBody(nextBody);
    localBody.current = nextBody;
    setStatus(nextStatus);
    localStatus.current = nextStatus;
    try {
      await notesOutbox.enqueue({
        environmentId,
        path: props.path,
        body: nextBody,
        status: nextStatus,
        baseRevision: editBase.current,
        localUpdatedAt: Date.now(),
      });
      setDirty(false);
      setEditing(false);
      setError(null);
      void flushNotes(environmentId).catch((error: unknown) => setError(notesError(error)));
    } catch (error) {
      setDirty(true);
      setError(notesError(error));
    }
    pendingSaves.current--;
    if (pendingSaves.current === 0) setSaving(false);
  };
  const bodyAvailable = hasSnapshot || note !== null || row !== undefined || props.create;
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={note?.title ?? props.path}
        sidebar={false}
        onBack={() => navigation.goBack()}
      />
      <NoteEditorScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 p-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) }}
      >
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {saving
            ? "Saving on phone…"
            : dirty
              ? "Unsaved edits"
              : row
                ? noteSyncLabel(noteSyncState(row))
                : !restored
                  ? "Loading saved edits…"
                  : props.create && !note && !row
                    ? "New note · save on phone to create"
                    : !bodyAvailable
                      ? "Not loaded"
                      : !connected
                        ? "Offline · showing last loaded note"
                        : "Synced with hub"}
        </Text>
        <Text className="text-sm text-foreground-muted">{props.path}</Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {notesOutbox.error(environmentId) ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {notesOutbox.error(environmentId)}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Refresh / sync"
            tone="secondary"
            disabled={saving || dirty}
            onPress={() => {
              setReload((value) => value + 1);
              void flushNotes(environmentId).catch((error: unknown) => setError(notesError(error)));
            }}
          />
          {row ? (
            <Button
              label="Discard saved edits"
              tone="secondary"
              disabled={saving || Boolean(row.inFlight)}
              onPress={() => {
                Alert.alert(
                  "Discard saved edits?",
                  "This removes this phone's draft. It does not delete a note already saved on the hub.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Discard",
                      style: "destructive",
                      onPress: () => {
                        void notesOutbox
                          .discard(environmentId, props.path, row.localUpdatedAt)
                          .then((removed) => {
                            if (removed) navigation.goBack();
                            else
                              setError(
                                "The draft changed or started syncing. Review it before discarding.",
                              );
                          })
                          .catch((error: unknown) => setError(notesError(error)));
                      },
                    },
                  ],
                );
              }}
            />
          ) : null}
          {row?.state === "conflict" ? (
            <Button
              tone="primary"
              label="Compare versions"
              onPress={() =>
                navigation.navigate("NoteConflict", { environmentId, path: props.path })
              }
            />
          ) : null}
        </View>
        {dirty && !editing ? (
          <Button
            fullWidth
            tone="primary"
            label="Retry saving on phone"
            disabled={saving || !canWrite}
            onPress={() => void save(localBody.current, localStatus.current)}
          />
        ) : null}
        {bodyAvailable ? (
          <>
            <View className="flex-row gap-2">
              {(["idea", "doing", "done"] as const).map((value) => (
                <Button
                  key={value}
                  label={value}
                  tone={status === value ? "primary" : "secondary"}
                  disabled={!canWrite || saving || row?.state === "conflict"}
                  selected={status === value}
                  onPress={() => {
                    if (editing) {
                      setStatus(value);
                      localStatus.current = value;
                      setDirty(true);
                    } else void save(localBody.current, value);
                  }}
                />
              ))}
            </View>
            {editing ? (
              <>
                <TextInput
                  accessibilityLabel="Note markdown"
                  multiline
                  autoFocus
                  textAlignVertical="top"
                  value={body}
                  editable={canWrite && !saving && restored}
                  onChangeText={(value) => {
                    setBody(value);
                    localBody.current = value;
                    setDirty(true);
                  }}
                  className="min-h-[320px] rounded-xl border border-input-border bg-input p-4 text-base text-foreground"
                />
                <Button
                  fullWidth
                  tone="primary"
                  label={saving ? "Saving…" : "Save on phone"}
                  disabled={!canWrite || saving || !restored}
                  onPress={() => void save(localBody.current, localStatus.current)}
                />
              </>
            ) : (
              <>
                <NoteMarkdown
                  key={checkboxRender}
                  body={body}
                  disabled={!canWrite || saving || row?.state === "conflict"}
                  onCheckbox={(event) => {
                    const next = applyNoteCheckboxEvent(localBody.current, event);
                    if (next === null) {
                      setError("Use Edit markdown for this checkbox.");
                      // Native toggles optimistically before emitting the event.
                      setCheckboxRender((value) => value + 1);
                    } else if (next !== localBody.current) void save(next, localStatus.current);
                  }}
                />
                <Button
                  fullWidth
                  label="Edit markdown"
                  tone="secondary"
                  disabled={!canWrite || saving || row?.state === "conflict"}
                  onPress={() => {
                    editBase.current = row?.baseRevision ?? note?.revision ?? null;
                    setEditing(true);
                  }}
                />
              </>
            )}
            <Button
              fullWidth
              tone="primary"
              label="Start work from this note"
              disabled={!canStart || !note || Boolean(row) || editing || saving || dirty}
              onPress={() =>
                navigation.navigate("NoteStartWork", { environmentId, path: props.path })
              }
            />
            {(note?.threads ?? row?.current?.threads ?? []).map((link) => (
              <NoteLinkedThread
                key={`${link.threadId}@${link.host ?? ""}`}
                environmentId={environmentId}
                link={link}
              />
            ))}
          </>
        ) : (
          <Text className="text-foreground-muted">Connect to the hub to open this note.</Text>
        )}
      </NoteEditorScrollView>
    </View>
  );
}

function NoteEditorScrollView(props: ComponentProps<typeof ScrollView>) {
  const content = <ScrollView {...props} />;
  // iOS needs the scroll view directly under the native header for automatic insets.
  // Android's KeyboardProvider disables native IME resize, so it needs keyboard avoidance.
  return Platform.OS === "android" ? (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
      {content}
    </KeyboardAvoidingView>
  ) : (
    content
  );
}

function NoteMarkdown(props: {
  readonly body: string;
  readonly disabled: boolean;
  readonly onCheckbox: (event: NoteCheckboxEvent) => void;
}) {
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  return (
    <SelectableMarkdownText
      markdown={props.body}
      preserveMarkdownSource
      textStyle={nativeTextStyle}
      onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
      onTaskListItemPress={props.disabled ? undefined : props.onCheckbox}
    />
  );
}
