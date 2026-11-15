import { formatTokens } from "@goat/shared/usageFormat";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";

export interface CompactBeforeSendState {
  readonly tokens: number;
  readonly keepFullHistory: boolean;
  readonly toggleKeepFullHistory: () => void;
}

/** Says whether the next send compacts a stale thread's history first, and switches it. */
export function CompactBeforeSendNotice(props: {
  readonly state: CompactBeforeSendState | null | undefined;
}) {
  if (!props.state) return null;
  return (
    <View className="px-4 pb-3">
      <Notice
        message={
          props.state.keepFullHistory
            ? `Your next message keeps all ${formatTokens(props.state.tokens)} tokens of history.`
            : `Your next message compacts ${formatTokens(props.state.tokens)} tokens of history first.`
        }
        icon="arrow.down.right.and.arrow.up.left"
        floating
        onDismiss={props.state.toggleKeepFullHistory}
        dismissLabel={props.state.keepFullHistory ? "Compact first" : "Keep the full history"}
      />
    </View>
  );
}
