import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { I18nManager, Platform } from "react-native";
import {
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import type { ScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { COLLAPSED_EDITOR_DEFAULT_INSET, collapsedEditorInset } from "./composer-editor-inset";
import { compactEditorInsets } from "./compactEditorInsets";

const INLINE_EDITOR_HEIGHT = 36;

export function useCompactComposerEditor(text: ScaledTextRole, value: string) {
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [compactWidth, setCompactWidth] = useState(0);
  const contentHeight = contentSize.height;
  const rowWidth = useSharedValue(0);
  const editorX = useSharedValue(0);
  const editorWidth = useSharedValue(0);
  const inset =
    Platform.OS === "android" ? COLLAPSED_EDITOR_DEFAULT_INSET : collapsedEditorInset(text);
  const minimum = Math.max(INLINE_EDITOR_HEIGHT, Math.ceil(text.lineHeight) + 2 * inset);
  const height = Math.max(
    minimum,
    Math.min(text.lineHeight * 4 + 2 * inset, contentHeight + 2 * inset),
  );
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too so widening cannot trigger a collapse loop.
  // iOS reports a ceiled width, so this can expand up to a point early; it never loops.
  const isExpanded =
    value.length > 0 &&
    (contentHeight > text.lineHeight * 1.5 ||
      (compactWidth > 0 && contentSize.width > compactWidth));
  // The editor rises out of the toolbar row inside its compact slot; only once it has left the
  // row does it widen and the model label expand, so text never draws over the row's controls.
  // Collapsing narrows it first, then lowers it back into the slot.
  const [hasRisen, setHasRisen] = useState(false);
  if (!isExpanded && hasRisen) setHasRisen(false);
  const isWide = isExpanded && (Platform.OS === "android" || hasRisen);
  // Only the latest animation may finish the rise: a collapse and re-expand can leave an older
  // completion queued.
  const riseGeneration = useRef(0);
  const finishRise = useEffectEvent((generation: number) => {
    if (generation === riseGeneration.current) setHasRisen(true);
  });
  const compactRowHeight = Math.max(44, minimum);
  const animatedHeight = useSharedValue(height);
  const surfaceHeight = useSharedValue(compactRowHeight);
  const targetSurfaceHeight = isExpanded ? height + 52 : compactRowHeight;
  const expansion = useSharedValue(0);
  useLayoutEffect(() => {
    const config = { duration: 180, reduceMotion: ReduceMotion.System };
    if (Platform.OS === "android") {
      animatedHeight.set(height);
      surfaceHeight.set(targetSurfaceHeight);
      expansion.set(Number(isExpanded));
      return;
    }
    // Resolve wrapping at the destination width before animating vertically.
    // Intermediate widths otherwise produce taller measurements mid-transition.
    riseGeneration.current += 1;
    const generation = riseGeneration.current;
    let nextFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        animatedHeight.set(withTiming(height, config));
        surfaceHeight.set(withTiming(targetSurfaceHeight, config));
        expansion.set(
          withTiming(Number(isExpanded), config, (finished) => {
            if (finished && isExpanded) runOnJS(finishRise)(generation);
          }),
        );
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (nextFrame !== undefined) cancelAnimationFrame(nextFrame);
    };
  }, [animatedHeight, expansion, height, isExpanded, surfaceHeight, targetSurfaceHeight]);
  const containerStyle = useAnimatedStyle(() => ({
    height: surfaceHeight.value,
  }));
  const isRTL = I18nManager.isRTL;
  const editorStyle = useAnimatedStyle(() => ({
    position: "absolute",
    overflow: "hidden",
    height: animatedHeight.value,
    ...(isWide
      ? { left: 14, right: 14 }
      : compactEditorInsets({
          slotX: editorX.value,
          slotWidth: editorWidth.value,
          rowWidth: rowWidth.value,
          isRTL,
        })),
    bottom:
      (compactRowHeight - minimum) / 2 + expansion.value * (52 - (compactRowHeight - minimum) / 2),
  }));
  return {
    isExpanded,
    /** The expanded toolbar layout: the editor spans the surface and the model label shows. */
    isWide,
    containerStyle,
    editorStyle,
    onRowLayout: (event: { nativeEvent: { layout: { width: number } } }) => {
      rowWidth.set(event.nativeEvent.layout.width);
    },
    onEditorLayout: (event: { nativeEvent: { layout: { x: number; width: number } } }) => {
      // The expanded toolbar gives this slot to the model control. Keep the
      // compact geometry for the return transition, rather than recording zero.
      if (!isWide) {
        editorX.set(event.nativeEvent.layout.x);
        editorWidth.set(event.nativeEvent.layout.width);
        setCompactWidth(Math.max(0, event.nativeEvent.layout.width - 8));
      }
    },
    editorProps: {
      singleLineCentered: !isExpanded,
      scrollEnabled: Platform.OS === "android" || contentHeight >= text.lineHeight * 4,
      contentInsetVertical: inset,
      onContentSizeChange: (size: { width: number; height: number }) => {
        setContentSize(size);
      },
      style: { flex: 1 },
    },
  };
}
