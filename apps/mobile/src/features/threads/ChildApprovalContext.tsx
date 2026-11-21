import { threadKey } from "@goat/client-runtime/state/entities";
import type { ScopedThreadRef } from "@goat/contracts";
import { Pressable, Text, View } from "react-native";

export type WaitingWorker = {
  readonly title: string;
} & (
  | { readonly thread: ScopedThreadRef; readonly observationKey?: string }
  | { readonly thread: null; readonly observationKey: string }
);

export function ChildApprovalContext(props: {
  readonly approvals: ReadonlyArray<WaitingWorker>;
  readonly onOpenWorker: (thread: ScopedThreadRef) => void;
}) {
  const workers = new Map(
    props.approvals.map((entry) => [
      entry.thread === null
        ? entry.observationKey
        : (entry.observationKey ?? threadKey(entry.thread)),
      entry,
    ]),
  );
  return (
    <View className="mx-3.5 my-2 gap-1">
      <Text className="font-goat-bold text-sm text-foreground">{workers.size} waiting</Text>
      {[...workers].map(([key, { thread, title }]) =>
        thread === null ? null : (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`Open worker · ${title}`}
            className="min-h-[44px] flex-row items-center justify-between gap-3"
            onPress={() => props.onOpenWorker(thread)}
          >
            <Text numberOfLines={1} className="shrink text-sm text-foreground">
              {title}
            </Text>
            <Text className="text-sm text-primary-text">Open worker</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}
