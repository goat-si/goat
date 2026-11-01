import { effortStepFraction } from "@goat/client-runtime/model-traits";
import * as Haptics from "expo-haptics";
import { useEffectEvent, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { cn } from "../../lib/cn";

const THUMB_SIZE = 32;

/** The web composer's effort slider: a dotted track whose thumb snaps between the model's steps. */
export function ReasoningStepSlider(props: {
  readonly label: string;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly isDefault?: boolean | undefined;
  }>;
  readonly index: number;
  readonly disabled: boolean;
  /** The step under the finger while dragging, null when the drag ends. */
  readonly onPreview: (index: number | null) => void;
  readonly onCommit: (index: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const count = props.steps.length;
  const shown = dragIndex ?? props.index;
  const travel = Math.max(0, width - THUMB_SIZE);
  const stopOffset = (index: number) => travel * effortStepFraction(index, count);
  const indexAt = (x: number) =>
    travel === 0
      ? props.index
      : Math.min(count - 1, Math.max(0, Math.round(((x - THUMB_SIZE / 2) / travel) * (count - 1))));
  const commit = (index: number) => {
    if (props.disabled || index === props.index) return;
    props.onCommit(index);
  };
  const preview = useEffectEvent((x: number) => {
    const next = indexAt(x);
    if (next === dragIndex) return;
    void Haptics.selectionAsync().catch(() => undefined);
    setDragIndex(next);
    props.onPreview(next);
  });
  const finish = useEffectEvent((x: number, success: boolean) => {
    setDragIndex(null);
    props.onPreview(null);
    if (success) commit(indexAt(x));
  });
  const tapped = useEffectEvent((x: number) => {
    const next = indexAt(x);
    if (next !== props.index) void Haptics.selectionAsync().catch(() => undefined);
    commit(next);
  });
  // oxlint-disable-next-line react/capitalized-calls -- Gesture factories, not React components.
  const pan = Gesture.Pan()
    .enabled(!props.disabled)
    .activeOffsetX([-6, 6])
    .failOffsetY([-14, 14])
    .runOnJS(true)
    .onStart((event) => preview(event.x))
    .onUpdate((event) => preview(event.x))
    .onFinalize((event, success) => finish(event.x, success));
  // oxlint-disable-next-line react/capitalized-calls -- Gesture factories, not React components.
  const tap = Gesture.Tap()
    .enabled(!props.disabled)
    .runOnJS(true)
    .onEnd((event, success) => {
      if (success) tapped(event.x);
    });

  // oxlint-disable-next-line react/capitalized-calls -- Gesture factories, not React components.
  const gesture = Gesture.Race(pan, tap);

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.label}
        accessibilityValue={{
          min: 0,
          max: Math.max(0, count - 1),
          now: shown,
          text:
            (props.steps[shown]?.label ?? "") + (props.steps[shown]?.isDefault ? " · Default" : ""),
        }}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "increment") commit(Math.min(count - 1, props.index + 1));
          if (nativeEvent.actionName === "decrement") commit(Math.max(0, props.index - 1));
        }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        className={cn(
          "h-8 w-full justify-center overflow-hidden rounded-full bg-subtle-strong",
          props.disabled && "opacity-60",
        )}
      >
        {width > 0 ? (
          <>
            <View
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: THUMB_SIZE + stopOffset(shown) }}
            />
            {props.steps.map((step, index) => (
              <View
                key={step.id}
                className={cn(
                  "absolute size-1 rounded-full",
                  index < shown
                    ? "bg-primary-foreground opacity-70"
                    : "bg-foreground-muted opacity-50",
                )}
                style={{ left: THUMB_SIZE / 2 + stopOffset(index) - 2 }}
              />
            ))}
            <View
              className="absolute size-8 rounded-full border border-black/10 bg-white shadow-md"
              style={{ left: stopOffset(shown) }}
            />
          </>
        ) : null}
      </View>
    </GestureDetector>
  );
}
