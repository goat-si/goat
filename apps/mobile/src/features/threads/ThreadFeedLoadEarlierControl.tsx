import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";

export interface ThreadFeedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
  /** Loads earlier history down to the entry, in one request. */
  /** Resolves whether that load brought history in; a failure ends a message jump. */
  readonly onLoadThrough: (entryId: string) => Promise<boolean>;
}

export function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center px-2">
      {props.hasMoreHistory ? (
        <View className="self-center">
          <Button
            label={props.loading ? "Loading earlier activity…" : "Load earlier activity"}
            tone="secondary"
            accessibilityLabel="Load earlier activity"
            disabled={props.loading}
            onPress={props.onLoadEarlier}
            icon="chevron.up"
            loading={props.loading}
          />
        </View>
      ) : null}
      {/* Mounted with the control so TalkBack announces an error line when it appears. */}
      <View collapsable={false} accessibilityLiveRegion="polite">
        {props.error !== null ? (
          <Text
            className={`text-center text-xs text-icon-subtle ${props.hasMoreHistory ? "mt-1.5" : ""}`}
          >
            {props.error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
