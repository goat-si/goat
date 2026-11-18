import * as Schema from "effect/Schema";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";
import { useStableCallback } from "./useStableCallback";

const WidthSchema = Schema.Finite;

/** The host must size itself from this custom property. */
export const RESIZABLE_WIDTH_PROPERTY = "--resizable-width";

// GOAT: a host its container caps (max-width, min()) shows less than the stored width.
function renderedWidth(host: HTMLElement | null): number | null {
  const width = host?.getBoundingClientRect().width ?? 0;
  return width > 0 ? Math.round(width) : null;
}

export interface UseResizableWidthOptions {
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly edge: "left" | "right";
}

export interface ResizableWidthHandlers {
  readonly ref: (node: HTMLElement | null) => (() => void) | undefined;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** Persist on drag end to avoid a storage write on every animation frame. */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.max(minWidth, Math.min(maxWidth, value));
  };

  const readWidth = () => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const stored = getLocalStorageItem(storageKey, WidthSchema);
      return clamp(stored ?? defaultWidth);
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return defaultWidth;
    }
  };
  const [widthState, setWidthState] = useState(() => ({ storageKey, width: readWidth() }));
  if (widthState.storageKey !== storageKey) {
    setWidthState({ storageKey, width: readWidth() });
  }

  const clampedWidth = clamp(widthState.width);
  const restoreWidth = useStableCallback((host: HTMLElement | null) => {
    host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${clampedWidth}px`);
  });

  const drag = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;
    // Disable drag transitions through transition-property; the host renders transition-duration.
    host?.style.setProperty("transition-property", "none");
    // The drag commits to the key and width it started from, even if the panel
    // switches keys before the pointer is released.
    const startStorageKey = storageKey;
    const startWidth = Math.min(clampedWidth, renderedWidth(host) ?? clampedWidth);
    let shownWidth: number | null = null;
    return {
      width: startWidth,
      edge,
      bounds: { min: minWidth, max: maxWidth },
      resize(nextWidth) {
        host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (!moved) {
          restoreWidth(host);
          return;
        }
        const savedWidth = Math.min(finalWidth, shownWidth ?? finalWidth);
        setWidthState({ storageKey: startStorageKey, width: savedWidth });
        try {
          setLocalStorageItem(startStorageKey, savedWidth, WidthSchema);
        } catch (error) {
          console.error("Could not persist panel width.", error);
        }
      },
      cleanup(committed) {
        // Read while transitions are still off: a read after would see where the animation starts.
        if (committed) shownWidth = renderedWidth(host);
        host?.style.removeProperty("transition-property");
        if (!committed) restoreWidth(host);
      },
    };
  });

  // Bounds can change mid-drag (sidebar opens, window narrows), and the render
  // that carries them rewrites the committed width, so re-apply the live pointer position.
  const { refresh } = drag;
  useLayoutEffect(() => refresh({ min: minWidth, max: maxWidth }), [refresh, minWidth, maxWidth]);

  return {
    width: clampedWidth,
    handlers: {
      ref: drag.ref,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
    },
  };
}
