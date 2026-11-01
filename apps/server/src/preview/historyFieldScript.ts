// Evaluated in the isolated world on the currently focused element.
export const HISTORY_FIELD_SCRIPT = `function () {
  const element = this;
  if (!element || !element.isConnected) return false;
  const root = element.getRootNode();
  if (root.activeElement !== element) return false;
  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
  if (autocomplete.some((token) => /^(?:one-time-code|cc-.*|current-password|new-password)$/.test(token))) return false;
  const security = getComputedStyle(element).getPropertyValue("-webkit-text-security");
  if (security && security !== "none") return false;
  if (element.disabled || element.readOnly || element.matches(":disabled")) return false;
  if (element instanceof HTMLInputElement) return ["text", "search", "url", "email", "tel"].includes(element.type);
  return element instanceof HTMLTextAreaElement || element.isContentEditable === true;
}`;
