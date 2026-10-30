import { type ReactNode, useCallback, useRef, useState } from "react";
import { View } from "react-native";

// Past the composer's 180 ms height animation.
const COMPOSER_HEIGHT_SETTLE_MS = 220;

/**
 * The cards stacked above the composer (guest share, usage notices, errors, questions). They
 * cover the feed like the composer does, so their height counts toward the feed's bottom inset.
 */
export function ComposerCards(props: {
  readonly maxWidth?: number;
  readonly onHeight: (height: number) => void;
  readonly children: ReactNode;
}) {
  return (
    <View
      className="w-full self-center"
      style={{ maxWidth: props.maxWidth }}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
    >
      {props.children}
    </View>
  );
}

/**
 * The composer and the status lines above it (offline, cloud notices). Measuring only the
 * composer let those lines cover the feed.
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
 * The cards and the slot animate their heights and report a layout every frame. The feed follows
 * those frames on the UI thread; this is only an estimate, so committing each frame would
 * re-render the screen.
 */
export function useSettledComposerHeight() {
  const [height, setHeight] = useState<number | null>(null);
  const parts = useRef({ cards: 0, slot: null as number | null });
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const report = useCallback(() => {
    if (parts.current.slot === null) return;
    const next = parts.current.cards + parts.current.slot;
    setHeight((current) => current ?? next);
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      setHeight(next);
    }, COMPOSER_HEIGHT_SETTLE_MS);
  }, []);
  const onCardsHeight = useCallback(
    (cards: number) => {
      parts.current.cards = cards;
      report();
    },
    [report],
  );
  const onSlotHeight = useCallback(
    (slot: number) => {
      parts.current.slot = slot;
      report();
    },
    [report],
  );
  const cancel = useCallback(() => {
    if (settle.current !== null) clearTimeout(settle.current);
  }, []);
  return { height, onCardsHeight, onSlotHeight, cancel };
}
