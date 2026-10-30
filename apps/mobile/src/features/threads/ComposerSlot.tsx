import { type ReactNode, useCallback, useRef, useState } from "react";
import { View } from "react-native";

// Past the composer's 180 ms height animation.
const COMPOSER_HEIGHT_SETTLE_MS = 220;

/**
 * The composer and the status lines above it (offline, cloud notices). The feed's bottom inset
 * is this whole slot's height: measuring only the composer let those lines cover the feed.
 */
export function ComposerSlot(props: {
  readonly hidden: boolean;
  readonly onHeight: (height: number) => void;
  readonly children: ReactNode;
}) {
  return (
    <View
      style={props.hidden ? { display: "none" } : undefined}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
    >
      {props.children}
    </View>
  );
}

/**
 * The slot animates its height and reports a layout every frame. The feed follows those frames on
 * the UI thread; this is only an estimate, so committing each frame would re-render the screen.
 */
export function useSettledComposerHeight() {
  const [height, setHeight] = useState<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHeight = useCallback((next: number) => {
    setHeight((current) => current ?? next);
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      setHeight(next);
    }, COMPOSER_HEIGHT_SETTLE_MS);
  }, []);
  const cancel = useCallback(() => {
    if (settle.current !== null) clearTimeout(settle.current);
  }, []);
  return { height, onHeight, cancel };
}
