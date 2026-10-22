import { useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { EnvironmentId } from "@goat/contracts";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { Button } from "../../components/ui/Button";
import { noteListRows, noteSyncLabel } from "./notes-model";
import {
  notesError,
  notesOutbox,
  useNotesFeed,
  useNotesOutbox,
  useNoteDraftAccess,
} from "./notes-state";
import { NotePath } from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodeNotePath = Schema.decodeUnknownOption(NotePath);

export function NotesRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environments = Object.values(savedConnectionsById);
  const [selected, setSelected] = useState<string | null>(null);
  const environment =
    environments.find((entry) => entry.environmentId === selected) ?? environments[0];
  const navigation = useNavigation();
  return (
    <View className="flex-1 bg-sheet">
      <AppBar title="Notes" sidebar={false} onBack={() => navigation.goBack()} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 p-4 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-sm text-foreground-muted">
          Notes live on the selected hub. Edits save on this phone before syncing.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {environments.map((entry) => (
            <Button
              key={entry.environmentId}
              label={entry.environmentLabel}
              tone={entry === environment ? "primary" : "secondary"}
              onPress={() => setSelected(entry.environmentId)}
            />
          ))}
        </View>
        {environment ? (
          <EnvironmentNotes
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : (
          <EmptyState title="Connect a hub" detail="Pair with your hub to read and edit notes." />
        )}
      </ScrollView>
    </View>
  );
}

function EnvironmentNotes({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const feed = useNotesFeed(environmentId);
  const outbox = useNotesOutbox();
  const { canEdit: canWrite, connected } = useNoteDraftAccess(environmentId);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const value = Option.getOrNull(AsyncResult.value(feed));
  const rows = noteListRows(environmentId, value?.notes ?? [], outbox);
  useEffect(() => {
    void notesOutbox.restore().catch((error: unknown) => setError(notesError(error)));
  }, []);
  const create = () => {
    const canonical = path.trim().normalize("NFC");
    const valid = decodeNotePath(canonical);
    if (Option.isNone(valid)) {
      setError("Use note.md or folder/note.md without hidden or empty path segments.");
      return;
    }
    if (rows.some((row) => row.path === valid.value)) {
      setError("A note with this path already exists. Open it from the list.");
      return;
    }
    setError(null);
    navigation.navigate("Note", { environmentId, path: valid.value, create: true });
  };
  return (
    <View className="gap-4">
      {!connected ? (
        <Text className="text-sm text-foreground-muted">
          Offline drafts stay on this phone and sync when this connection has edit access.
        </Text>
      ) : null}
      {canWrite ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="New note path"
            placeholder="folder/note.md"
            autoCapitalize="none"
            value={path}
            onChangeText={setPath}
            className="rounded-xl border border-input-border bg-input p-3 text-foreground"
          />
          <Button
            fullWidth
            label="Create note"
            tone="secondary"
            disabled={!path.trim()}
            onPress={create}
          />
        </View>
      ) : (
        <Text className="text-sm text-foreground-muted">This connection has read-only access.</Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {AsyncResult.isFailure(feed) ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {notesError(Cause.squash(feed.cause))} Saved edits remain on this phone.
        </Text>
      ) : null}
      {value?.error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {value.error}
        </Text>
      ) : null}
      {value?.truncated ? (
        <Text className="text-foreground-muted">The hub returned a partial list.</Text>
      ) : null}
      {rows.length === 0 ? (
        <Text className="text-foreground-muted">
          {value ? "No notes yet." : "Connecting to the hub…"}
        </Text>
      ) : null}
      {rows.map((row, index) => (
        <View key={row.path} className="gap-2">
          {index === 0 || rows[index - 1]?.folder !== row.folder ? (
            <Text className="font-goat-bold text-lg text-foreground">{row.folder ?? "Notes"}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("Note", { environmentId, path: row.path })}
            className="gap-1 rounded-xl border border-border bg-card p-4"
          >
            <Text className="font-goat-bold text-foreground">{row.title}</Text>
            <Text className="text-sm text-foreground-muted">
              {row.status} · {row.path}
            </Text>
            {row.sync !== "synced" ? (
              <View className="flex-row items-center gap-2">
                <View
                  className={
                    row.sync === "conflict"
                      ? "size-1.5 rounded-full bg-warning-foreground"
                      : "size-1.5 rounded-full bg-foreground-muted"
                  }
                />
                <Text className="text-xs text-foreground-muted">{noteSyncLabel(row.sync)}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      ))}
    </View>
  );
}
