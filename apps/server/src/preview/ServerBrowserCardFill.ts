import type { CardDetails } from "@goat/contracts";

type RemoteReply = {
  readonly result?: { readonly objectId?: string; readonly value?: unknown };
  readonly exceptionDetails?: unknown;
};
type Send = (
  method: string,
  params: Record<string, unknown>,
  onDispatch?: () => void,
) => Promise<RemoteReply>;
type FieldName = "number" | "expiry" | "month" | "year" | "cvc" | "name";
type Field = { readonly objectId: string; readonly value: string };

const VISIBLE = `(field) => {
  if (!field.getClientRects().length) return false;
  for (let node = field; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
  }
  return true;
}`;

const FIND_FIELDS = `function () {
  let focused = document.activeElement;
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement;
  const form = focused && focused.form;
  if (!form) return "no_form";
  const usable = (field) => (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) &&
    field.form === form && field.ownerDocument === document && field.isConnected && !field.disabled &&
    !field.readOnly && (${VISIBLE})(field);
  const all = [...form.elements].filter(usable);
  const match = (token) => all.filter((field) => (field.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes(token));
  if (match("cc-given-name").length || match("cc-family-name").length) return "unsupported_split_name";
  const keys = [["number", "cc-number"], ["cvc", "cc-csc"], ["expiry", "cc-exp"],
    ["month", "cc-exp-month"], ["year", "cc-exp-year"], ["name", "cc-name"]];
  const found = { form };
  for (const [key, token] of keys) {
    const fields = match(token);
    if (fields.length > 1) return "ambiguous_" + key;
    if ((key === "number" || key === "cvc") && !fields.length) return "missing_" + key;
    if (fields[0] && (key === "number" || key === "cvc" || key === "name" || key === "expiry") && !(fields[0] instanceof HTMLInputElement)) return "unsupported_" + key;
    found[key] = fields[0];
  }
  if (found.expiry && (found.month || found.year)) return "ambiguous_expiry";
  return found;
}`;

const MATCH_OPTION = `(field, which, month, year) => {
  const expected = which === "month" ? [String(Number(month)), String(Number(month)).padStart(2, "0")] : [year, year.slice(-2)];
  return [...field.options].filter((option) => !option.disabled && expected.some((value) => option.value.trim() === value || option.text.trim() === value));
}`;

const MUTATE = `function (which, value, origin, month, year) {
  // GOAT_CARD_MUTATE
  let focused = document.activeElement;
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement;
  const usable = (field) => (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) &&
    field.form === this.form && field.ownerDocument === document && field.isConnected && !field.disabled && !field.readOnly && (${VISIBLE})(field);
  if (self.origin !== origin || !focused || focused.form !== this.form ||
      ![this.number, this.cvc, this.expiry, this.month, this.year, this.name].filter(Boolean).every(usable)) return "changed";
  const field = this[which];
  if (field instanceof HTMLSelectElement) {
    const options = (${MATCH_OPTION})(field, which, month, year);
    if (options.length !== 1) return "no_option";
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(field, options[0].value);
  } else {
    const actual = which === "expiry" && field.type === "month" ? year + "-" + month.padStart(2, "0") : value;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, actual);
  }
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const READ_BACK = `function (origin, values, month, year) {
  if (self.origin !== origin) return false;
  return Object.entries(values).every(([which, value]) => {
    const field = this[which];
    if (!field || !field.isConnected || field.ownerDocument !== document || field.form !== this.form) return false;
    if (field instanceof HTMLSelectElement) {
      const options = (${MATCH_OPTION})(field, which, month, year);
      return options.length === 1 && field.selectedOptions.length === 1 && field.selectedOptions[0] === options[0];
    }
    const actual = which === "expiry" && field.type === "month" ? year + "-" + month.padStart(2, "0") : value;
    return field.value === actual;
  });
}`;

export const fillCard = async (input: {
  readonly send: Send;
  readonly contextId: number;
  readonly origin: string;
  readonly card: CardDetails;
  readonly register: (value: string) => void;
  readonly protect: (field: Field) => () => void;
  readonly canDispatch?: () => boolean;
  readonly onDispatch?: () => void;
}) => {
  const month = String(Number(input.card.expiryMonth)).padStart(2, "0");
  const values: Record<FieldName, string> = {
    number: input.card.number,
    expiry: `${month}/${input.card.expiryYear}`,
    month: input.card.expiryMonth,
    year: input.card.expiryYear,
    cvc: input.card.cvc,
    name: input.card.name,
  };
  for (const value of Object.values(values)) input.register(value);
  const found = await input.send("Runtime.callFunctionOn", {
    functionDeclaration: FIND_FIELDS,
    executionContextId: input.contextId,
    returnByValue: false,
  });
  if (found.exceptionDetails) throw new Error("Could not inspect the card form.");
  const objectId = found.result?.objectId;
  const empty = {
    numberFilled: false,
    cvcFilled: false,
    expiryFilled: false,
    expiryMonthFilled: false,
    expiryYearFilled: false,
    nameFilled: false,
  };
  if (!objectId)
    return {
      ...empty,
      verdict: "refused" as const,
      code: typeof found.result?.value === "string" ? found.result.value : "no_form",
    };
  const pending = new Set<string>();
  const release = (id: string) =>
    input.send("Runtime.releaseObject", { objectId: id }).catch(() => {});
  const filled: Partial<Record<FieldName, string>> = {};
  const status = () => ({
    numberFilled: filled.number !== undefined,
    cvcFilled: filled.cvc !== undefined,
    expiryFilled:
      filled.expiry !== undefined || filled.month !== undefined || filled.year !== undefined,
    expiryMonthFilled: filled.month !== undefined,
    expiryYearFilled: filled.year !== undefined,
    nameFilled: filled.name !== undefined,
  });
  try {
    const fields: Array<{ name: FieldName; field: Field }> = [];
    for (const name of ["number", "expiry", "month", "year", "cvc", "name"] as const) {
      const reply = await input.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function (key) { return this[key]; }",
        arguments: [{ value: name }],
        returnByValue: false,
      });
      if (reply.exceptionDetails) throw new Error("Could not retain a card field.");
      const id = reply.result?.objectId;
      if (id) {
        pending.add(id);
        fields.push({ name, field: { objectId: id, value: values[name] } });
      } else if (name === "number" || name === "cvc")
        throw new Error("Could not retain a required card field.");
    }
    for (const { name, field } of fields) {
      if (input.canDispatch && !input.canDispatch())
        return {
          ...status(),
          verdict: Object.keys(filled).length ? ("unverifiable" as const) : ("refused" as const),
          code: "form_changed",
        };
      const unprotect = input.protect(field);
      pending.delete(field.objectId);
      let dispatched = false;
      let reply: RemoteReply;
      try {
        reply = await input.send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: MUTATE,
            arguments: [
              { value: name },
              { value: field.value },
              { value: input.origin },
              { value: month },
              { value: input.card.expiryYear },
            ],
            returnByValue: true,
          },
          () => {
            dispatched = true;
            input.onDispatch?.();
          },
        );
      } catch (cause) {
        if (!dispatched) {
          unprotect();
          await release(field.objectId);
        }
        throw cause;
      }
      if (reply.exceptionDetails) throw new Error("Card input delivery is uncertain.");
      if (reply.result?.value === true) {
        filled[name] = field.value;
        continue;
      }
      if (reply.result?.value === "changed" || reply.result?.value === "no_option") {
        unprotect();
        await release(field.objectId);
        return {
          ...status(),
          verdict: Object.keys(filled).length ? ("unverifiable" as const) : ("refused" as const),
          code: reply.result.value === "changed" ? "form_changed" : `no_option_${name}`,
        };
      }
      throw new Error("Card input delivery is uncertain.");
    }
    const checked = await input
      .send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: READ_BACK,
        arguments: [
          { value: input.origin },
          { value: filled },
          { value: month },
          { value: input.card.expiryYear },
        ],
        returnByValue: true,
      })
      .catch(() => undefined);
    return {
      ...status(),
      verdict:
        checked && !checked.exceptionDetails && checked.result?.value === true
          ? ("confirmed" as const)
          : ("unverifiable" as const),
    };
  } finally {
    for (const id of pending) await release(id);
    await release(objectId);
  }
};
