import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { sideChatMarker } from "./sideChatMarker";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const ROW_CLASS_NAME =
  "mx-4 mb-2 min-h-11 flex-row items-center gap-1.5 rounded-[20px] border border-border-subtle bg-card-alt px-4";

/** Names the thread a side chat belongs to; tapping the name opens that thread. */
export function SideChatParentRow(props: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "sideChatOf">;
}) {
  const { environmentId, sideChatOf } = props.thread;
  const parentShell = useQuietThreadShell(
    sideChatOf == null ? null : { environmentId, threadId: sideChatOf },
  );
  const openLinkedThread = useOpenLinkedThread();
  const marker = sideChatMarker(props.thread, parentShell);
  if (marker === null) return null;
  const parent = marker.parent;
  if (parent === null)
    return (
      <View accessibilityRole="text" className={ROW_CLASS_NAME}>
        <Text numberOfLines={1} className="text-xs text-foreground-secondary">
          Side chat
        </Text>
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Side chat of ${parent.title}`}
      accessibilityHint="Opens the main thread"
      onPress={() =>
        openLinkedThread({ environmentId: parent.environmentId, threadId: parent.threadId })
      }
      className={`${ROW_CLASS_NAME} active:opacity-65`}
    >
      <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-secondary">
        Side chat of <Text className="font-goat-medium text-foreground">{parent.title}</Text>
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}
