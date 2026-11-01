/** The global chat capture handler must leave this chord to the focused PDF. */
export function isPdfFindShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target">,
) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f" &&
    event.target instanceof Element &&
    event.target.closest("[data-pdf-viewer]") !== null
  );
}
