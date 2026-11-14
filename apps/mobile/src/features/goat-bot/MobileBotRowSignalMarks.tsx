import { Text, View } from "react-native";

import type { MobileBotRowSignals } from "./useMobileBotRowSignals";

/** The signals as a row shows them; the row's own label speaks them. */
export function MobileBotRowSignalMarks(props: { readonly signals: MobileBotRowSignals | null }) {
  const { signals } = props;
  if (signals === null || (!signals.missing && !(signals.unread !== null && signals.unread > 0)))
    return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-1"
    >
      {signals.unread !== null && signals.unread > 0 ? (
        <Text className="rounded-full bg-subtle-strong px-1.5 text-xs font-semibold text-foreground">
          {signals.unread}
        </Text>
      ) : null}
      {signals.missing ? (
        <Text className="rounded-full border border-border px-1.5 text-xs text-foreground-muted">
          –
        </Text>
      ) : null}
    </View>
  );
}
