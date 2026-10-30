import { historyRows } from "@goat/client-runtime/computer-use-history";
import type {
  ComputerUseHistoryCursor,
  ComputerUseHistoryEntry,
  ComputerUseHistoryResult,
} from "@goat/contracts";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

type Cursor = typeof ComputerUseHistoryCursor.Type;
type Result = typeof ComputerUseHistoryResult.Type;

export function ThreadComputerUseHistoryView(props: {
  readonly canRead: boolean;
  readonly load: (cursor: Cursor | null) => Promise<Result>;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<typeof ComputerUseHistoryEntry.Type>>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const load = async () => {
    if (!props.canRead || pending.current || (loaded && cursor === null)) return;
    pending.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const page = await props.load(cursor);
      setEntries((previous) => [...previous, ...page.entries]);
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setLoading(false);
    }
  };
  return (
    <View className="gap-2">
      {entries.length > 0 ? (
        <ScrollView style={{ maxHeight: 256 }} nestedScrollEnabled>
          {historyRows(entries).map((row) => (
            <View key={row.id} className="gap-1 border-b border-border py-2">
              <Text className="text-xs text-foreground-muted">
                {row.time} · {row.target}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {row.method}
                {row.label ? ` · ${row.label}` : ""}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {row.verdict}
                {row.refusal ? ` · ${row.refusal}` : ""}
              </Text>
              {row.typed === null ? null : (
                <Text className="text-xs text-foreground-muted">Typed: {row.typed}</Text>
              )}
            </View>
          ))}
        </ScrollView>
      ) : loaded ? (
        <Text>No input history.</Text>
      ) : null}
      {failed ? <Text>Could not load input history.</Text> : null}
      {!loaded || cursor !== null ? (
        <Button
          tone="text"
          label={loading ? "Loading…" : loaded ? "Load more" : "Show input history"}
          disabled={!props.canRead || loading}
          onPress={() => void load()}
        />
      ) : null}
    </View>
  );
}
