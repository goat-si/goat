import { ScrollView, type ScrollViewProps } from "react-native";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";

export function PullRequestTabScrollView(props: ScrollViewProps) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}
