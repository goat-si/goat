type Reply = {
  readonly result?: { readonly objectId?: string; readonly value?: unknown };
  readonly exceptionDetails?: unknown;
};
type Field = { readonly objectId: string; readonly value: string };
type Send = (
  method: string,
  params: Record<string, unknown>,
  onDispatch?: () => void,
) => Promise<Reply>;

const VISIBLE = `(field) => {
  if (!field.getClientRects().length) return false;
  for (let node = field; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
  }
  return true;
}`;

const FIND = `function () {
  let focused = document.activeElement;
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement;
  const form = focused && focused.form;
  if (!form) return "no_form";
  const usable = (field) => field instanceof HTMLInputElement && field.form === form && field.ownerDocument === document &&
    field.isConnected && !field.disabled && !field.readOnly && (${VISIBLE})(field);
  const inputs = [...form.elements].filter(usable);
  const named = inputs.filter((field) => (field.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes("one-time-code"));
  const singles = inputs.filter((field) => ["text", "tel", "number"].includes(field.type) && field.maxLength === 1);
  if (singles.some((field, i) => i > 0 && inputs.indexOf(field) === inputs.indexOf(singles[i - 1]) + 1)) return "unsupported_split_code";
  if (named.length > 1) return "ambiguous_code";
  const field = named[0] || (usable(focused) && ["text", "tel", "number"].includes(focused.type) && focused.maxLength >= 4 && focused.maxLength <= 10 ? focused : null);
  if (!field || !["text", "tel", "number"].includes(field.type) || field.maxLength === 1) return "missing_code";
  return { form, field };
}`;

const MUTATE = `function (origin, value) {
  // GOAT_CODE_MUTATE
  let focused = document.activeElement;
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement;
  const field = this.field;
  if (self.origin !== origin || !focused || focused.form !== this.form || !(field instanceof HTMLInputElement) ||
      field.form !== this.form || field.ownerDocument !== document || !field.isConnected || field.disabled || field.readOnly ||
      !["text", "tel", "number"].includes(field.type) || field.maxLength === 1 || !(${VISIBLE})(field)) return "changed";
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const READ_BACK = `function (origin, value) {
  return self.origin === origin && this.field.ownerDocument === document && this.field.isConnected &&
    this.field.form === this.form && this.field.value === value;
}`;

export const fillCode = async (input: {
  readonly send: Send;
  readonly contextId: number;
  readonly origin: string;
  readonly code: string;
  readonly register: (value: string) => void;
  readonly protect: (field: Field) => () => void;
  readonly canDispatch?: () => boolean;
  readonly onDispatch?: () => void;
}) => {
  const found = await input.send("Runtime.callFunctionOn", {
    functionDeclaration: FIND,
    executionContextId: input.contextId,
    returnByValue: false,
  });
  if (found.exceptionDetails) throw new Error("Could not inspect the code form.");
  const objectId = found.result?.objectId;
  if (!objectId)
    return {
      filled: false,
      verdict: "refused" as const,
      code: typeof found.result?.value === "string" ? found.result.value : "no_form",
    };
  const release = (id: string) =>
    input.send("Runtime.releaseObject", { objectId: id }).catch(() => {});
  let pending: string | undefined;
  try {
    const field = await input.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this.field; }",
      returnByValue: false,
    });
    pending = field.result?.objectId;
    if (field.exceptionDetails || !pending) throw new Error("Could not retain the code field.");
    if (input.canDispatch && !input.canDispatch()) {
      return { filled: false, verdict: "refused" as const, code: "form_changed" };
    }
    input.register(input.code);
    const unprotect = input.protect({ objectId: pending, value: input.code });
    const fieldId = pending;
    pending = undefined;
    let dispatched = false;
    let reply: Reply;
    try {
      reply = await input.send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: MUTATE,
          arguments: [{ value: input.origin }, { value: input.code }],
          returnByValue: true,
        },
        () => {
          dispatched = true;
          input.onDispatch?.();
        },
      );
    } catch (error) {
      if (!dispatched) {
        unprotect();
        await release(fieldId);
      }
      throw error;
    }
    if (reply.exceptionDetails) throw new Error("Code input delivery is uncertain.");
    if (reply.result?.value === "changed") {
      unprotect();
      await release(fieldId);
      return { filled: false, verdict: "refused" as const, code: "form_changed" };
    }
    if (reply.result?.value !== true) throw new Error("Code input delivery is uncertain.");
    const checked = await input
      .send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: READ_BACK,
        arguments: [{ value: input.origin }, { value: input.code }],
        returnByValue: true,
      })
      .catch(() => undefined);
    return {
      filled: true,
      verdict:
        checked && !checked.exceptionDetails && checked.result?.value === true
          ? ("confirmed" as const)
          : ("unverifiable" as const),
    };
  } finally {
    if (pending) await release(pending);
    await release(objectId);
  }
};
