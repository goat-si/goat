// Lets the command palette, which mounts outside the sidebar provider, toggle the main sidebar.
type Listener = () => void;
const listeners = new Set<Listener>();

export function requestSidebarToggle(): void {
  for (const listener of listeners) listener();
}

export function subscribeSidebarToggleRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
