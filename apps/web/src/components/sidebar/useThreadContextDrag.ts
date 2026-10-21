import type { ScopedThreadRef } from "@goat/contracts";
import { parseScopedThreadKey } from "@goat/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { isMacPlatform } from "../../lib/utils";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "../chat/threadContextDrag";
import { SIDEBAR_DRAG_DISTANCE, SidebarPointerSensor } from "../Sidebar.pointer";

/**
 * Dragging a sidebar thread row past the left or right edge of its list hands the thread to a
 * composer as context (see chat/threadContextDrag.ts). Both sidebar views share this path.
 * Whether a row may drag out is independent of whether it may sort: Priority rows, rows on
 * servers without ordering support, and Projects view rows never sort but still drag out.
 */

const LIST_ATTRIBUTE = "data-thread-context-drag-list";
// Nested controls keep their own press behavior instead of starting a row drag.
const NESTED_CONTROL_SELECTOR = "a, button, input, textarea, select, [contenteditable='true']";

/** Marks the element whose horizontal bounds count as "inside the list". */
export function threadContextDragListProps() {
  return { [LIST_ATTRIBUTE]: "true" } as const;
}

export interface ThreadContextDragSubject {
  readonly key: string;
  readonly title: string;
  readonly list: Element | null;
}

/** Threads a drag hands over: the whole selection when the picked-up row belongs to it. */
function threadContextDragRefs(key: string): ScopedThreadRef[] {
  const selected = useThreadSelectionStore.getState().selectedThreadKeys;
  const keys = selected.has(key) ? [...selected] : [key];
  return keys.flatMap((candidate) => {
    const ref = parseScopedThreadKey(candidate);
    return ref ? [ref] : [];
  });
}

function isOutsideList(list: Element | null, point: { x: number; y: number }): boolean {
  if (list === null || !list.isConnected) return false;
  const bounds = list.getBoundingClientRect();
  return point.x < bounds.left || point.x > bounds.right;
}

/**
 * The context half of a sidebar row drag. Feed `move` and `drop` to a SidebarPointerSensor's
 * options: each returns true while the pointer is outside the list, which claims the position
 * from any sort gesture. `begin` names the dragged row once the gesture starts; `end` clears it.
 */
export function useThreadContextDrag(
  options: { readonly onContextDragChange?: (contextDrag: boolean) => void } = {},
) {
  const subjectRef = useRef<ThreadContextDragSubject | null>(null);
  const contextDragRef = useRef(false);
  const onContextDragChangeRef = useRef(options.onContextDragChange);
  useLayoutEffect(() => {
    onContextDragChangeRef.current = options.onContextDragChange;
  }, [options.onContextDragChange]);
  const begin = (subject: ThreadContextDragSubject) => {
    subjectRef.current = subject;
    contextDragRef.current = false;
  };
  const move = (point: { x: number; y: number }) => {
    const subject = subjectRef.current;
    const contextDrag = subject !== null && isOutsideList(subject.list, point);
    if (contextDragRef.current !== contextDrag) {
      contextDragRef.current = contextDrag;
      onContextDragChangeRef.current?.(contextDrag);
    }
    if (subject === null || !contextDrag) {
      endThreadContextDrag();
      return false;
    }
    moveThreadContextDrag(point, {
      title: subject.title.trim() || "Thread",
      count: threadContextDragRefs(subject.key).length,
    });
    return true;
  };
  const drop = (point: { x: number; y: number }) => {
    const subject = subjectRef.current;
    if (subject === null || !isOutsideList(subject.list, point)) return false;
    dropThreadContext(point, threadContextDragRefs(subject.key));
    // Releasing outside the list never sorts, whether or not a composer took the drop.
    return true;
  };
  const end = () => {
    subjectRef.current = null;
    contextDragRef.current = false;
    endThreadContextDrag();
  };
  return { begin, move, drop, end };
}

interface ThreadContextDragPress {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly defaultPrevented: boolean;
  readonly nativeEvent: { readonly isPrimary: boolean };
  readonly target: EventTarget;
  readonly currentTarget: Element;
}

/** Only a plain primary press on the row itself can start a context drag. */
function shouldStartThreadContextDrag(press: ThreadContextDragPress, platform: string): boolean {
  if (press.defaultPrevented || press.button !== 0 || !press.nativeEvent.isPrimary) return false;
  // Ctrl-click opens the context menu on macOS.
  if (press.ctrlKey && isMacPlatform(platform)) return false;
  const target = press.target instanceof Element ? press.target : null;
  const control = target?.closest(NESTED_CONTROL_SELECTOR) ?? null;
  return (
    control === null || control === press.currentTarget || !press.currentTarget.contains(control)
  );
}

const noop = () => {};

/**
 * Pointer listener for a row that can drag out but never sorts. Spread the result on the row
 * root; it is undefined while disabled and keeps its identity across renders otherwise.
 * Every move is claimed, so nothing in the list moves and releasing inside it changes nothing.
 */
export function useThreadContextDragHandle(input: {
  readonly threadKey: string;
  readonly title: string;
  readonly disabled: boolean;
}) {
  const drag = useThreadContextDrag();
  const rowRef = useRef({ threadKey: input.threadKey, title: input.title });
  useLayoutEffect(() => {
    rowRef.current = { threadKey: input.threadKey, title: input.title };
  }, [input.threadKey, input.title]);
  const sensorRef = useRef<SidebarPointerSensor | null>(null);
  useEffect(() => () => sensorRef.current?.cancel(), []);
  // A row that stops allowing context drag mid-press (rename, or it became sortable) drops
  // the gesture too, so the press cannot finish as a context drop.
  useEffect(() => {
    if (input.disabled) sensorRef.current?.cancel();
  }, [input.disabled]);
  const onPointerDown = (event: ReactPointerEvent<Element>) => {
    if (!shouldStartThreadContextDrag(event, navigator.platform)) return;
    sensorRef.current?.cancel();
    const { threadKey, title } = rowRef.current;
    const list = event.currentTarget.closest(`[${LIST_ATTRIBUTE}]`);
    // The sensor owns its document listeners from here until release or cancellation.
    void new SidebarPointerSensor({
      active: threadKey,
      event: event.nativeEvent,
      options: {
        distance: SIDEBAR_DRAG_DISTANCE,
        onAttach: (sensor) => {
          sensorRef.current = sensor;
        },
        onFinish: () => {
          sensorRef.current = null;
          drag.end();
        },
        onMove: (point) => {
          drag.move(point);
          return true;
        },
        onDrop: drag.drop,
      },
      onPending: noop,
      onStart: () => drag.begin({ key: threadKey, title, list }),
      onMove: noop,
      onEnd: noop,
      onCancel: noop,
      onAbort: noop,
    });
  };
  return input.disabled ? undefined : { onPointerDown };
}
