import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RunId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { memoryEnvironment } from "../../state/memory";

type Target = { environmentId: EnvironmentId; threadId: ThreadId; runId: RunId };

export function TurnMemoryDetails(target: Target) {
  const allowed = useAtomValue(memoryEnvironment.canInspectTurnMemory(target.environmentId));
  return allowed ? <Disclosure key={JSON.stringify(target)} {...target} /> : null;
}

function Disclosure(target: Target) {
  const [open, setOpen] = useState(false);
  return (
    <View className="px-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="self-end py-1"
        onPress={() => setOpen(!open)}
      >
        <AppText className="text-xs text-muted-foreground">Turn memory</AppText>
      </Pressable>
      {open ? <Receipts {...target} /> : null}
    </View>
  );
}

function Receipts({ environmentId, threadId, runId }: Target) {
  const result = useAtomValue(
    memoryEnvironment.turnMemoryForRun({ environmentId, input: { threadId, runId } }),
  );
  if (result === null) return <AppText>Loading turn memory…</AppText>;
  if (Option.isNone(result)) return <AppText>Turn memory is unavailable.</AppText>;
  if (!result.value.events.length)
    return <AppText>No memory activity was recorded for this turn.</AppText>;
  return (
    <View className="gap-2 rounded-md border border-border p-3">
      {result.value.events.map((event, index) => (
        <View key={index}>
          <AppText className="font-semibold">
            {event.kind === "automatic" ? "Provided to the model" : "Memory recall"}
          </AppText>
          {event.query && <AppText>Query: {event.query}</AppText>}
          {event.items.length === 0 && <AppText>No visible entries.</AppText>}
          {event.items.map((item) => (
            <View key={item.memoryId}>
              {item.excerpt && <AppText>{item.excerpt}</AppText>}
              <AppText selectable className="text-xs text-muted-foreground">
                {item.memoryId} · Revision {item.revisionId}
              </AppText>
            </View>
          ))}
        </View>
      ))}
      {result.value.truncated && <AppText>Only the first recorded events are shown.</AppText>}
    </View>
  );
}
