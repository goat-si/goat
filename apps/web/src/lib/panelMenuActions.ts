const EVENT_NAME = "goat:panel-menu-action";

export type PanelMenuAction =
  | "rightPanel.toggle"
  | "rightPanel.toggleMaximized"
  | "rightPanel.close";

/** Runs a panel action the way the desktop View menu does, for the panel in front. */
export function dispatchPanelMenuAction(action: PanelMenuAction): void {
  window.dispatchEvent(new CustomEvent<PanelMenuAction>(EVENT_NAME, { detail: action }));
}

export function subscribePanelMenuAction(listener: (action: string) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PanelMenuAction>).detail;
    if (typeof detail === "string") listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
