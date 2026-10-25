import {
  PREVIEW_SESSION_STACK_WINDOW_NAME,
  type DesktopPreviewSessionStackState,
} from "@goat/contracts";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MinimizeIcon, PictureInPictureIcon } from "~/components/solar";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

import { useDocumentVisible } from "./PreviewSessionThumbnail";

const captureNotice = (state: DesktopPreviewSessionStackState | null) => {
  switch (state?.captureProtection) {
    case "unsupported":
      return "This system cannot exclude the floating stack from screen capture. If its controls are unavailable, Dock remains in GOAT.";
    case "macos-sharing-none":
      return "Capture protection is requested, but macOS ScreenCaptureKit can still capture this stack.";
    case "windows-monitor-only":
      return "This Windows version records a black rectangle in place of the stack.";
    default:
      return null;
  }
};

const failure = (error: unknown) => {
  toastManager.add({
    type: "error",
    title: "Could not move the agent sessions stack",
    description: error instanceof Error ? error.message : String(error),
  });
};

function copyStyles(doc: Document) {
  doc.head.replaceChildren(
    ...Array.from(document.head.querySelectorAll('style,link[rel="stylesheet"]'), (node) =>
      node.cloneNode(true),
    ),
  );
  for (const attribute of Array.from(document.documentElement.attributes))
    doc.documentElement.setAttribute(attribute.name, attribute.value);
  doc.documentElement.style.setProperty("background", "transparent", "important");
  doc.body.style.setProperty("background", "transparent", "important");
  doc.body.style.margin = "0";
}

/**
 * A portal keeps navigation, stores and the existing thumbnail stream in the owning React tree.
 * With a desktop bridge the stack always renders into one host element, which moves between its
 * place in GOAT and the floating window: a card survives Pop out and Dock with its own state,
 * such as the last frame a stopped session no longer sends (#1518).
 */
export function PreviewSessionStackSurface(props: {
  readonly hasContent: boolean;
  readonly dockedHidden: boolean;
  readonly children: (surface: {
    readonly floating: boolean;
    readonly live: boolean;
    readonly maxHeight: number | undefined;
    readonly toggle: ReactNode;
    readonly captureNotice: string | null;
  }) => ReactNode;
}) {
  const bridge = window.desktopBridge?.previewSessionStack;
  const [native, setNative] = useState<DesktopPreviewSessionStackState | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const child = useRef<Window | null>(null);
  const visible = useDocumentVisible(target?.ownerDocument);
  const content = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    if (!bridge) return null;
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const floating = target !== null;
  const shown = props.hasContent && (floating || !props.dockedHidden);
  const interactive = useRef(false);

  const open = useStableCallback(() => {
    if (child.current && !child.current.closed) return;
    const next = window.open("about:blank", PREVIEW_SESSION_STACK_WINDOW_NAME);
    if (!next) throw new Error("The floating window could not be opened.");
    child.current = next;
    next.document.title = "Agents on screen";
    const root = next.document.createElement("div");
    next.document.body.replaceChildren(root);
    setTarget(root);
  });

  // Before paint, so the stack never shows in both places or in neither.
  useLayoutEffect(() => {
    if (!host) return;
    const place = target ?? anchor.current;
    if (place && host.parentNode !== place) place.append(host);
  }, [host, target]);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onState((state) => {
      if (disposed) return;
      interactive.current = false;
      setNative(state);
      if (!state.open) {
        child.current = null;
        setTarget(null);
      }
    });
    void bridge
      .request({ type: "state" })
      .then((state) => {
        if (disposed) return;
        setNative(state);
        if (state.poppedOut) open();
      })
      .catch(failure);
    return () => {
      disposed = true;
      unsubscribe();
      child.current = null;
      // Releasing a React host (including StrictMode) keeps the app's restart preference.
      void bridge.request({ type: "release" }).catch(failure);
    };
  }, [bridge, open]);

  useEffect(() => {
    if (!target) return;
    const doc = child.current?.document;
    if (!doc) return;
    const syncStyles = () => copyStyles(doc);
    syncStyles();
    const observer = new MutationObserver(syncStyles);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, [target]);

  useEffect(() => {
    if (!target || !bridge) return;
    const root = content.current;
    if (!root) return;
    const measure = () => {
      void bridge
        .request({
          type: "layout",
          height: shown ? root.getBoundingClientRect().height : 0,
        })
        .catch(failure);
    };
    measure();
    return observeResize(root, measure);
  }, [bridge, shown, target]);

  const setInteractive = (target: EventTarget | null) => {
    // The child has a different Element constructor; test the DOM method across realms.
    const next =
      target !== null &&
      "closest" in target &&
      typeof target.closest === "function" &&
      target.closest("[data-stack-interactive]") !== null;
    if (next === interactive.current) return;
    interactive.current = next;
    void bridge?.request({ type: "interactive", interactive: next }).catch(failure);
  };
  const toggle =
    bridge && native ? (
      <Button
        variant="ghost-muted"
        size="icon-xs"
        // An icon keeps the header on one line beside Stop all; the label names it.
        aria-label={floating ? "Dock" : "Pop out"}
        title={floating ? "Dock into GOAT" : "Pop out over other apps"}
        onClick={() => {
          if (floating) void bridge.request({ type: "dock" }).catch(failure);
          else {
            try {
              open();
            } catch (error) {
              failure(error);
            }
          }
        }}
      >
        {floating ? <MinimizeIcon /> : <PictureInPictureIcon />}
      </Button>
    ) : null;
  const notice = captureNotice(native);
  const stack = shown
    ? props.children({
        floating,
        live: visible && (!floating || native?.visible === true),
        maxHeight: floating ? Math.max(0, (native?.maxHeight ?? 1) - 8) : undefined,
        toggle,
        captureNotice: floating ? notice : null,
      })
    : null;
  if (!host) return stack;
  const portal = createPortal(
    <div
      ref={content}
      className={floating ? "p-1" : "contents"}
      onMouseMove={floating ? (event) => setInteractive(event.target) : undefined}
      onMouseLeave={floating ? () => setInteractive(null) : undefined}
    >
      {stack}
    </div>,
    host,
  );
  return (
    <>
      {/* Linux cannot forward ignored mouse movement; Dock remains reachable in GOAT. */}
      {floating && native?.mouseEventForwarding === false ? (
        <div className="fixed top-14 right-3 z-40 rounded-lg border bg-popover p-1">{toggle}</div>
      ) : null}
      {floating ? null : <div ref={anchor} className="contents" />}
      {portal}
    </>
  );
}
