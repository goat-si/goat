import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type NoteDocument, type NoteStatus } from "@goat/contracts";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Platform, ScrollView as NativeScrollView, View } from "react-native";
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
import {
  NoteLiveEditor,
  useNoteEditorTheme,
  type NoteLiveEditorHandle,
} from "./live-editor/NoteLiveEditor";
import { NoteEditorToolbar } from "./live-editor/NoteEditorToolbar";
import { noteEditorSupport } from "./live-editor/note-editor-support";
import type { NoteLineBreak } from "./live-editor/note-editor-protocol";
import { noteSyncLabel, noteSyncState } from "./notes-model";
import { notesRpc } from "./rpc/notes";
import { noteConflictCurrent } from "./rpc/delivery";
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
  const remove = useAtomCommand(notesRpc.delete, notesCommandOptions);
  const [note, setNote] = useState<NoteDocument | null>(row?.current ?? null);
  const [body, setBody] = useState(row?.body ?? "");
  // An acknowledgement can remove the outbox row while this editor still owns newer text.
  const [hasSnapshot, setHasSnapshot] = useState(Boolean(row) || Boolean(props.create));
  const [status, setStatus] = useState<NoteStatus>(row?.status ?? "idea");
  const [editing, setEditing] = useState(Boolean(props.create));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const busy = saving || deleting;
  const [checkboxRender, setCheckboxRender] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  // Which editor owns the current edit: the live editor, or the markdown source fallback.
  const [surface, setSurface] = useState<"live" | "source">("live");
  const [liveUnavailable, setLiveUnavailable] = useState<string | null>(null);
  // The live editor is re-reading its own text; its latest edits may not be in body yet.
  const [editorPending, setEditorPending] = useState(false);
  const editorPendingRef = useRef(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const editorFocusedRef = useRef(false);
  const liveEditor = useRef<NoteLiveEditorHandle>(null);
  const editorTheme = useNoteEditorTheme();
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
  // This phone's last saved snapshot; once the hub holds exactly it, its revision is the next base.
  const savedSnapshot = useRef<{ body: string; status: NoteStatus } | null>(null);
  // Bumped when a delete starts or adopts the hub's version, so older reads cannot overwrite it.
  const readEpoch = useRef(0);
  const latest = Option.getOrNull(AsyncResult.value(feed))?.notes.find(
    (entry) => entry.path === props.path,
  );
  const editorHolding = editorPending && liveUnavailable === null;
  usePreventRemove(dirty || saving || editorHolding, ({ data }) => {
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
    // A re-syncing editor may hold text newer than body; a hub read must not replace it.
    if (
      !restored ||
      !connected ||
      row ||
      editing ||
      saving ||
      dirty ||
      editorHolding ||
      (props.create && !latest)
    )
      return;
    let active = true;
    const epoch = readEpoch.current;
    void read({ environmentId: readRequest.environmentId, input: readRequest.input }).then(
      (result) => {
        if (!active || epoch !== readEpoch.current) return;
        if (AsyncResult.isSuccess(result)) {
          savedSnapshot.current = null;
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
  }, [
    readRequest,
    props.create,
    latest,
    row,
    editing,
    saving,
    dirty,
    read,
    restored,
    connected,
    editorHolding,
  ]);
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
    if (!canWrite || deletingRef.current) return;
    setSaving(true);
    pendingSaves.current++;
    setBody(nextBody);
    localBody.current = nextBody;
    setStatus(nextStatus);
    localStatus.current = nextStatus;
    const edit = {
      environmentId,
      path: props.path,
      body: nextBody,
      status: nextStatus,
      baseRevision: editBase.current,
      localUpdatedAt: Date.now(),
    };
    // A focused editor skips the read after an acknowledged save; the outbox then bases this
    // save on the hub's revision of the previous one.
    const continues = savedSnapshot.current;
    const enqueue = () =>
      continues ? notesOutbox.enqueue(edit, continues) : notesOutbox.enqueue(edit);
    let stored = false;
    try {
      editBase.current = await enqueue();
      stored = true;
    } catch (error) {
      setDirty(true);
      setError(notesError(error));
    }
    if (stored) {
      savedSnapshot.current = { body: nextBody, status: nextStatus };
      // Edits that arrived while the outbox was writing are not in this snapshot.
      if (localBody.current === nextBody && localStatus.current === nextStatus) {
        setDirty(false);
        // A focused live editor keeps editing, so hub reads cannot replace text under the cursor.
        setEditing(editorFocusedRef.current);
      }
      setError(null);
      void flushNotes(environmentId).catch((error: unknown) => setError(notesError(error)));
    }
    pendingSaves.current--;
    if (pendingSaves.current === 0) setSaving(false);
  };
  const adopt = (document: NoteDocument) => {
    readEpoch.current++;
    setNote(document);
    setBody(document.body);
    localBody.current = document.body;
    setStatus(document.status);
    localStatus.current = document.status;
    editBase.current = document.revision;
  };
  const deleteNote = async (target: NoteDocument) => {
    if (deletingRef.current) return;
    // The confirmation can stay open while the editor gains focus, edits or starts a re-sync.
    if (
      editorPendingRef.current ||
      editorFocusedRef.current ||
      localBody.current !== target.body ||
      localStatus.current !== target.status
    ) {
      setError("This note has edits on this phone. Save or discard them before deleting.");
      return;
    }
    // A draft can be saved or restored while the confirmation is open.
    const draft = notesOutbox
      .getSnapshot()
      .some((entry) => entry.environmentId === environmentId && entry.path === props.path);
    if (draft) {
      setError("This phone has edits for this note. Sync or discard them before deleting.");
      return;
    }
    deletingRef.current = true;
    readEpoch.current++;
    setDeleting(true);
    const result = await remove({
      environmentId,
      input: { path: target.path, baseRevision: target.revision },
    });
    deletingRef.current = false;
    setDeleting(false);
    if (AsyncResult.isSuccess(result)) {
      navigation.goBack();
      return;
    }
    const failure = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;
    const current = noteConflictCurrent(failure);
    if (current) {
      adopt(current);
      setError(
        "This note changed on the hub. Review it, then delete it again if you still want to.",
      );
    } else setError(notesError(failure));
  };
  const canDelete =
    canStart && restored && note !== null && !row && !editing && !dirty && !busy && !editorHolding;
  const bodyAvailable = hasSnapshot || note !== null || row !== undefined || props.create;
  const beginEdit = (target: "live" | "source") => {
    if (editing) return;
    editBase.current = row?.baseRevision ?? note?.revision ?? null;
    setSurface(target);
    setEditing(true);
  };
  const support = noteEditorSupport(body);
  const liveEditing = editing && surface === "live";
  // An editing session keeps its line break, so deleting the last CRLF does not remount it.
  const [liveBreak, setLiveBreak] = useState<NoteLineBreak>(
    support.kind === "live" ? support.lineBreak : "\n",
  );
  if (!liveEditing && support.kind === "live" && support.lineBreak !== liveBreak)
    setLiveBreak(support.lineBreak);
  const live =
    bodyAvailable &&
    liveUnavailable === null &&
    (liveEditing || (support.kind === "live" && !(editing && surface === "source")));
  const sourceReason = liveUnavailable ?? (support.kind === "source" ? support.reason : null);
  const canEditBody = canWrite && row?.state !== "conflict";
  const syncText = saving
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
                : "Synced with hub";
  const saveButton = (
    <Button
      fullWidth
      tone="primary"
      label={saving ? "Saving…" : "Save on phone"}
      disabled={!canWrite || saving || !restored || editorHolding}
      onPress={() => void save(localBody.current, localStatus.current)}
    />
  );
  const header = (
    <>
      <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
        {syncText}
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
      {bodyAvailable && !live && sourceReason && !editing ? (
        <Text className="text-sm text-foreground-muted">{sourceReason}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Refresh / sync"
          tone="secondary"
          disabled={busy || dirty}
          onPress={() => {
            setReload((value) => value + 1);
            void flushNotes(environmentId).catch((error: unknown) => setError(notesError(error)));
          }}
        />
        {row ? (
          <Button
            label="Discard saved edits"
            tone="secondary"
            disabled={busy || Boolean(row.inFlight)}
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
            onPress={() => navigation.navigate("NoteConflict", { environmentId, path: props.path })}
          />
        ) : null}
      </View>
      {dirty && !editing ? (
        <Button
          fullWidth
          tone="primary"
          label="Retry saving on phone"
          disabled={saving || !canWrite || editorHolding}
          onPress={() => void save(localBody.current, localStatus.current)}
        />
      ) : null}
      {bodyAvailable ? (
        <View className="flex-row gap-2">
          {(["idea", "doing", "done"] as const).map((value) => (
            <Button
              key={value}
              label={value}
              tone={status === value ? "primary" : "secondary"}
              disabled={!canWrite || busy || editorHolding || row?.state === "conflict"}
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
      ) : null}
    </>
  );
  const footer = (
    <>
      <Button
        fullWidth
        tone="primary"
        label="Start work from this note"
        disabled={!canStart || !note || Boolean(row) || editing || busy || dirty || editorHolding}
        onPress={() => navigation.navigate("NoteStartWork", { environmentId, path: props.path })}
      />
      <Button
        fullWidth
        tone="danger"
        label={deleting ? "Deleting…" : "Delete note"}
        disabled={!canDelete}
        onPress={() => {
          if (!note) return;
          const target = note;
          Alert.alert("Delete note?", `“${target.title}” will be removed from Notes on the hub.`, [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => void deleteNote(target),
            },
          ]);
        }}
      />
      {(note?.threads ?? row?.current?.threads ?? []).map((link) => (
        <NoteLinkedThread
          key={`${link.threadId}@${link.host ?? ""}`}
          environmentId={environmentId}
          link={link}
        />
      ))}
    </>
  );
  if (live)
    return (
      <View className="flex-1 bg-sheet">
        <AppBar
          title={note?.title ?? props.path}
          sidebar={false}
          onBack={() => navigation.goBack()}
        />
        <KeyboardAvoidingView behavior="padding" className="flex-1">
          {editorFocused ? (
            <View className="flex-row items-center gap-3 border-b border-border px-4 py-2">
              <Text
                accessibilityLiveRegion="polite"
                className="flex-1 text-xs text-foreground-muted"
              >
                {syncText}
              </Text>
              {dirty || (props.create && !note && !row) ? (
                <Button
                  tone="primary"
                  label={saving ? "Saving…" : "Save on phone"}
                  disabled={!canWrite || saving || !restored || editorHolding}
                  onPress={() => void save(localBody.current, localStatus.current)}
                />
              ) : null}
            </View>
          ) : (
            <NativeScrollView
              style={{ flexGrow: 0, maxHeight: "45%" }}
              keyboardShouldPersistTaps="handled"
              contentContainerClassName="gap-3 p-4"
            >
              {header}
              {dirty || (props.create && !note && !row) ? saveButton : null}
              {footer}
            </NativeScrollView>
          )}
          <NoteLiveEditor
            key={liveBreak}
            ref={liveEditor}
            value={body}
            lineBreak={liveBreak}
            autoFocus={props.create}
            config={{ editable: canEditBody, readOnly: busy || !restored, theme: editorTheme }}
            onChange={(next, checkbox) => {
              setBody(next);
              localBody.current = next;
              if (checkbox && !editing) {
                if (canWrite && !deletingRef.current) void save(next, localStatus.current);
                else setDirty(true);
                return;
              }
              beginEdit("live");
              setDirty(true);
            }}
            onFocusChange={(focused) => {
              editorFocusedRef.current = focused;
              setEditorFocused(focused);
              if (focused) beginEdit("live");
              else if (!dirty && !saving) setEditing(false);
            }}
            onSourceChange={setShowSource}
            onLink={(href) => void tryOpenExternalUrl(href, "markdown-link")}
            onUnavailable={setLiveUnavailable}
            onPendingChange={(pending) => {
              editorPendingRef.current = pending;
              setEditorPending(pending);
            }}
          />
          {editorFocused ? (
            <NoteEditorToolbar
              source={showSource}
              disabled={!canEditBody || busy}
              onCommand={(command) => liveEditor.current?.command(command)}
            />
          ) : (
            <View style={{ height: insets.bottom }} />
          )}
        </KeyboardAvoidingView>
      </View>
    );
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
        {header}
        {bodyAvailable ? (
          <>
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
                {saveButton}
              </>
            ) : (
              <>
                <NoteMarkdown
                  key={checkboxRender}
                  body={body}
                  disabled={!canWrite || busy || row?.state === "conflict"}
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
                  disabled={!canWrite || busy || row?.state === "conflict"}
                  onPress={() => beginEdit("source")}
                />
              </>
            )}
            {footer}
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
