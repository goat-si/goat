export type PreviewAction =
  | "toggle-panel"
  | "refresh"
  | "back"
  | "forward"
  | "focus-url"
  | "find"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom";

const desktopActions = new Map<string, PreviewAction>([
  ["preview.find", "find"],
  ["preview.focusUrl", "focus-url"],
  ["preview.zoomIn", "zoom-in"],
  ["preview.zoomOut", "zoom-out"],
  ["preview.resetZoom", "reset-zoom"],
]);

export const desktopPreviewAction = (action: string) => desktopActions.get(action);

const EVENT_NAME = "goat:preview-action";

export function dispatchPreviewAction(action: PreviewAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PreviewAction>(EVENT_NAME, { detail: action }));
}

export function subscribePreviewAction(listener: (action: PreviewAction) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PreviewAction>).detail;
    if (typeof detail === "string") listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
