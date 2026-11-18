import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { ThreadCreationFailedCard } from "./ThreadCreationFailedCard";

/** The failed-creation card among the composer cards, with its entry and exit animation. */
export function ThreadCreationFailedSlot(props: {
  readonly reason: string;
  readonly onEditTask: () => void;
  readonly bottomInset: number;
}) {
  return (
    <Animated.View
      className="shrink-0 px-4"
      style={{ paddingBottom: props.bottomInset }}
      entering={FadeInDown.duration(220)}
      exiting={FadeOut.duration(140)}
    >
      <ThreadCreationFailedCard reason={props.reason} onEditTask={props.onEditTask} />
    </Animated.View>
  );
}
