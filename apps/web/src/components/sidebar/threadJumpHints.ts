import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@goat/contracts";
import { deadlineAfter, deadlineStore, type ClockStore } from "@goat/client-runtime/clock";
import * as React from "react";

import { isElectron } from "../../env";
import { shouldShowThreadJumpHintsForModifiers } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { readPreviewShown } from "../../lib/previewShown";
import { isTerminalFocused, subscribeToTerminalFocusChanges } from "../../lib/terminalFocus";
import { isModelPickerOpen, subscribeToModelPickerVisibility } from "../../modelPickerVisibility";
import { useRightPanelStore } from "../../rightPanelStore";
import { shortcutModifierStore } from "../../shortcutModifierState";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

// Read at event time: subscribing Sidebar to terminal or modifier state re-renders every row.
export function threadShortcutContext(routeThreadRef: ScopedThreadRef | null) {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen:
      routeThreadRef !== null &&
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        routeThreadRef,
      ).terminalOpen,
    previewFocus: isPreviewFocused(),
    previewOpen: routeThreadRef !== null && readPreviewShown(routeThreadRef),
    modelPickerOpen: isModelPickerOpen(),
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

/** Whether the current modifier combination, including none, has been held unchanged for `delayMs`. */
function createModifierHoldStore(delayMs: number): ClockStore<boolean> {
  const listeners = new Set<() => void>();
  let held = false;
  let stopDeadline = () => {};
  let stopModifiers: (() => void) | null = null;

  const setHeld = (next: boolean) => {
    if (held === next) return;
    held = next;
    for (const listener of listeners) listener();
  };
  const onModifiersChange = () => {
    stopDeadline();
    const deadline = deadlineStore(deadlineAfter(delayMs));
    stopDeadline = deadline.subscribe(() => setHeld(true));
    // A deadline another subscriber already passed never notifies a late joiner.
    setHeld(deadline.getSnapshot());
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (stopModifiers === null) {
        stopModifiers = shortcutModifierStore.subscribe(onModifiersChange);
        onModifiersChange();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopModifiers?.();
        stopModifiers = null;
        stopDeadline();
        stopDeadline = () => {};
        held = false;
      };
    },
    getSnapshot: () => held,
  };
}

const threadJumpModifierHold = createModifierHoldStore(THREAD_JUMP_HINT_SHOW_DELAY_MS);

function subscribeToThreadJumpHintInputs(listener: () => void): () => void {
  const unsubscribeHold = threadJumpModifierHold.subscribe(listener);
  const unsubscribeFocus = subscribeToTerminalFocusChanges(listener);
  const unsubscribeTerminals = useTerminalUiStateStore.subscribe(listener);
  const unsubscribeRightPanels = useRightPanelStore.subscribe(listener);
  const unsubscribeModelPicker = subscribeToModelPickerVisibility(listener);
  return () => {
    unsubscribeHold();
    unsubscribeFocus();
    unsubscribeTerminals();
    unsubscribeRightPanels();
    unsubscribeModelPicker();
  };
}

/**
 * Thread jump hints appear once the jump modifier has been held for a moment,
 * so a quick shortcut never flashes them, and hide as soon as it is released.
 * The snapshot is the visibility itself, so a quick shortcut never re-renders the caller.
 */
export function useThreadJumpHintsVisible(
  keybindings: ResolvedKeybindingsConfig,
  routeThreadRef: ScopedThreadRef | null,
): boolean {
  return React.useSyncExternalStore(
    subscribeToThreadJumpHintInputs,
    () =>
      threadJumpModifierHold.getSnapshot() &&
      shouldShowThreadJumpHintsForModifiers(shortcutModifierStore.getSnapshot(), keybindings, {
        platform: navigator.platform,
        context: threadShortcutContext(routeThreadRef),
      }),
  );
}
