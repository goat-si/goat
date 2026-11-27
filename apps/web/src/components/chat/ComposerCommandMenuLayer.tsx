import { type ReactNode, useDeferredValue, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observeResize } from "~/lib/observeResize";

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

/** Mounts the layer one deferred render after `open` turns true, so the keystroke that opened it paints first. */
export function DeferredComposerCommandMenuLayer({
  open,
  ...props
}: Parameters<typeof ComposerCommandMenuLayer>[0] & { open: boolean }) {
  const mounted = useDeferredValue(open, false);
  return open && mounted ? <ComposerCommandMenuLayer {...props} /> : null;
}

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  children: ReactNode;
  canOverflowTop?: boolean;
}) {
  const { anchor, canOverflowTop } = props;
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;

    const updatePosition = () => {
      const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]');
      const mainSurface = form?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect();
      const rootFontSizePx =
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const drawerInsetRem = Number.parseFloat(
        window.getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
      );
      const drawerInset = drawerInsetRem * rootFontSizePx;
      const width = rect.width - drawerInset * 2;
      if (width <= 0) {
        setPosition(null);
        return;
      }
      const composerOverlap = rootFontSizePx + 1;
      const spaceAbove = rect.top + composerOverlap;
      const preferredBottom = window.innerHeight - spaceAbove;
      const preferredHeight = Math.max(96, spaceAbove - 24);
      const maxHeight = canOverflowTop
        ? preferredHeight
        : Math.min(preferredHeight, window.innerHeight);
      const next = {
        bottom: canOverflowTop
          ? preferredBottom
          : Math.min(preferredBottom, window.innerHeight - maxHeight),
        left: rect.left + drawerInset,
        maxHeight,
        width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observed: Element[] = [anchor];
    for (let element = anchor.parentElement; element; element = element.parentElement) {
      observed.push(element);
    }
    const stopObserving = observeResize(observed, updatePosition);

    return () => {
      stopObserving();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchor, canOverflowTop]);

  if (!anchor || !position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-40 flex flex-col"
      data-composer-drawer-layer="true"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
