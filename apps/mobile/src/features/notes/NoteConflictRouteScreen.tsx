import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@goat/contracts";
import { diffNoteLines, type NoteDiffLine } from "@goat/client-runtime/notes";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  flushNotes,
  notesError,
  notesOutbox,
  useNotesOutbox,
  useNoteDraftAccess,
} from "./notes-state";

export function NoteConflictRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; path: string }>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const row = useNotesOutbox().find(
    (row) => row.environmentId === environmentId && row.path === route.params.path,
  );
  const diff = useMemo(
    () => diffNoteLines(row?.body ?? "", row?.current?.body ?? ""),
    [row?.body, row?.current?.body],
  );
  const { canEdit: allowed } = useNoteDraftAccess(environmentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (choice: "mine" | "theirs") => {
    setPending(true);
    try {
      await notesOutbox.resolve(environmentId, route.params.path, choice);
      void flushNotes(environmentId).catch((error: unknown) =>
        console.warn("[notes] sync failed", error),
      );
      navigation.goBack();
    } catch (error) {
      setError(notesError(error));
    }
    setPending(false);
  };
  return (
    <View className="flex-1 bg-sheet">
      <AppBar title="Compare versions" sidebar={false} onBack={() => navigation.goBack()} />
      {row?.current ? (
        <>
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 p-4"
          >
            <View className="gap-1">
              <Text className="text-sm text-foreground-muted">
                + Added on this phone · − Removed from the hub version
              </Text>
              <Text className="text-xs text-foreground-muted">
                Keep mine can conflict again if the hub changes.
                {diff.wholeBlock ? " Large note: highlighting whole versions." : ""}
              </Text>
            </View>
            <View className="gap-3">
              <NoteVersion
                title="On this phone"
                status={row.status ?? row.current.status}
                lines={diff.phone}
              />
              <NoteVersion title="On the hub" status={row.current.status} lines={diff.hub} />
            </View>
          </ScreenScrollView>
          <View className="gap-2 px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            {error ? (
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button
                  fullWidth
                  label="Use theirs"
                  tone="secondary"
                  disabled={pending}
                  onPress={() => void resolve("theirs")}
                />
              </View>
              <View className="flex-1">
                <Button
                  fullWidth
                  tone="primary"
                  label="Keep mine"
                  disabled={pending || !allowed}
                  onPress={() => void resolve("mine")}
                />
              </View>
            </View>
          </View>
        </>
      ) : (
        <ScreenScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1">
          <Text className="p-4 text-foreground-muted">This note has no unresolved conflict.</Text>
        </ScreenScrollView>
      )}
    </View>
  );
}

function NoteVersion({
  title,
  status,
  lines,
}: {
  readonly title: string;
  readonly status: string;
  readonly lines: ReadonlyArray<NoteDiffLine>;
}) {
  // Stateless rows use source positions because blank and repeated lines have identical text.
  // oxlint-disable react/no-array-index-key
  return (
    <View className="overflow-hidden rounded-xl border border-border bg-card">
      <Text
        accessibilityRole="header"
        className="border-b border-border px-3 py-2 font-goat-bold text-foreground"
      >
        {title} · {status}
      </Text>
      <View className="py-2">
        {lines.length === 0 ? (
          <Text className="px-3 text-foreground-muted">Empty note</Text>
        ) : (
          lines.map((line, index) => (
            <Text
              key={index}
              selectable
              className={
                line.kind === "added"
                  ? "bg-emerald-500/10 px-3 py-0.5 text-foreground"
                  : line.kind === "removed"
                    ? "bg-rose-500/10 px-3 py-0.5 text-foreground"
                    : "px-3 py-0.5 text-foreground"
              }
            >
              {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
              {line.text || " "}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}
// oxlint-enable react/no-array-index-key
