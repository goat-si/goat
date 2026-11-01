// Any value left in the field counts: an edit must not lift the fence on most of the password.
// An empty or detached field keeps its entry until its document goes, and then any text field of
// that document holding the value, or four or more characters of it, holds the fence instead.
export const STILL_FILLED = `function (value) {
  if (this.isConnected && this.value !== "") return this.type === "password" ? "hidden" : "shown";
  const root = this.ownerDocument;
  if (!root || typeof value !== "string") return "empty";
  const typed = new Set(["text", "password", "search", "email", "tel", "url", "hidden"]);
  let state = "empty";
  const visit = (scope) => {
    for (const field of scope.querySelectorAll("input, textarea")) {
      const area = field.localName === "textarea";
      const held = field.value;
      if (!held || (!area && !typed.has(field.type))) continue;
      if (!held.includes(value) && !(held.length >= 4 && value.includes(held))) continue;
      if (area || (field.type !== "password" && field.type !== "hidden")) state = "shown";
      else if (state === "empty") state = "hidden";
    }
    for (const element of scope.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(root);
  return state;
}`;
