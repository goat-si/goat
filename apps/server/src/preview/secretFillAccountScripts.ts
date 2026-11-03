// The identifier field a password field belongs to, as the sign-in state reads it.
const IDENTIFIER_FIELD_OF = `(field) => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const named = (input) => /username|email/i.test(input.autocomplete || "");
  const collect = (root) => {
    const found = [...root.querySelectorAll("input")];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...collect(el.shadowRoot));
    return found;
  };
  const candidates = (root) => collect(root).filter(
    (input) => input !== field && visible(input) && !input.disabled &&
      (["text", "email", "tel"].includes(input.type) || named(input)),
  );
  // The nearest scope that has one: the form, the field's shadow root, then the whole document.
  const scopes = [field.form || field.closest("form"), field.getRootNode(), field.ownerDocument];
  const inputs = scopes.filter(Boolean).map(candidates).find((found) => found.length > 0) || [];
  const before = inputs.filter((input) => input.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING);
  return inputs.find(named) || before[before.length - 1] || null;
}`;
const IDENTIFIER_OF = `(field) => {
  const id = (${IDENTIFIER_FIELD_OF})(field);
  return id ? id.value.trim() : null;
}`;
export const IDENTIFIER = `function () { return (${IDENTIFIER_OF})(this); }`;
// The name a form request carries the identifier under; null without one or without a name.
export const IDENTIFIER_NAME = `function () {
  const id = (${IDENTIFIER_FIELD_OF})(this);
  return id && id.name ? id.name : null;
}`;
// Without an identifier field, page text names the account: as a whole address, and no other one.
const NAMED_ONLY = `(wanted) => {
  const text = document.body ? document.body.innerText.toLowerCase() : "";
  const part = (c) => c !== undefined && /[a-z0-9._%+@-]/.test(c);
  let whole = false;
  for (let at = text.indexOf(wanted); at !== -1 && !whole; at = text.indexOf(wanted, at + 1)) {
    const after = text.slice(at + wanted.length).replace(/^[.]+/, "");
    whole = !part(text[at - 1]) && !part(after[0]);
  }
  const addresses = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}/g) || [];
  return whole && addresses.every((address) => address === wanted);
}`;
// Rechecks, in the same call that types, that the form still shows the account it showed when
// the field was found, and the expected account when the caller named one.
export const FILL = `function (value, origin, identifier, account) {
  if (!(this instanceof HTMLInputElement) || this.type !== "password" || this.disabled ||
    this.readOnly || !this.isConnected || this.ownerDocument !== document || self.origin !== origin)
    return false;
  const shown = (${IDENTIFIER_OF})(this);
  if (shown !== identifier) return "account";
  // With an identifier field, only that field counts; page text names the account only without one.
  const wanted = account === null ? null : account.toLowerCase();
  if (wanted !== null && (shown !== null ? shown.toLowerCase() !== wanted : !(${NAMED_ONLY})(wanted)))
    return "account";
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement)
    active = active.shadowRoot.activeElement;
  if (active === this) this.blur();
  return true;
}`;
