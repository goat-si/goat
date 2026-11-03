type RemoteReply = {
  readonly result?: { readonly objectId?: string; readonly value?: unknown };
  readonly exceptionDetails?: unknown;
};

type Send = (method: string, params: Record<string, unknown>) => Promise<RemoteReply>;

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
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement)
    focused = focused.shadowRoot.activeElement;
  const form = focused && focused.form;
  if (!form) return "no_form";
  const usable = (element) => element instanceof HTMLInputElement && element.form === form &&
    element.ownerDocument === document && element.isConnected && !element.disabled &&
    !element.readOnly && (${VISIBLE})(element);
  const inputs = [...form.elements].filter(usable);
  const passwords = inputs.filter((field) => field.type === "password");
  if (passwords.length !== 1) return passwords.length ? "ambiguous_password" : "missing_password";
  const password = passwords[0];
  const identifiers = inputs.filter((field) => ["text", "email", "tel"].includes(field.type));
  const named = identifiers.filter((field) => /(?:^|\\s)(?:username|email)(?:\\s|$)/i.test(field.autocomplete || ""));
  const before = identifiers.filter((field) => field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
  const candidates = named.length ? named : before;
  if (candidates.length !== 1) return candidates.length ? "ambiguous_identifier" : "missing_identifier";
  return { username: candidates[0], password, form, original: candidates[0].value.trim() };
}`;

const MUTATE = `function (which, value, origin, username) {
  // GOAT_LOGIN_MUTATE
  const u = this.username, p = this.password;
  const usable = (field) => field instanceof HTMLInputElement && field.form === this.form &&
    field.ownerDocument === document && field.isConnected && !field.disabled && !field.readOnly &&
    (${VISIBLE})(field);
  if (self.origin !== origin || !usable(u) || !usable(p) || p.type !== "password") return "changed";
  const shown = u.value.trim();
  if (which === "username") {
    if (shown !== this.original || (shown !== "" && shown.toLowerCase() !== username.trim().toLowerCase())) return "account";
  } else if (shown.toLowerCase() !== username.trim().toLowerCase()) return "account";
  const field = which === "username" ? u : p;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const READ_BACK = `function (origin, username, password) {
  const u = this.username, p = this.password;
  return self.origin === origin && u.ownerDocument === document && p.ownerDocument === document &&
    u.isConnected && p.isConnected && u.form === this.form && p.form === this.form &&
    u.value === username && p.value === password;
}`;

export const fillLogin = async (input: {
  readonly send: Send;
  readonly contextId: number;
  readonly origin: string;
  readonly login: { readonly username: string; readonly password: string };
  readonly register: (value: string) => void;
}) => {
  const found = await input.send("Runtime.callFunctionOn", {
    functionDeclaration: FIND_FIELDS,
    executionContextId: input.contextId,
    returnByValue: false,
  });
  if (found.exceptionDetails) throw new Error("Could not inspect the sign-in form.");
  const objectId = found.result?.objectId;
  if (!objectId) {
    const code = found.result?.value;
    return {
      usernameFilled: false,
      passwordFilled: false,
      verdict: "refused" as const,
      code: typeof code === "string" ? code : "no_form",
    };
  }
  try {
    input.register(input.login.username);
    input.register(input.login.password);
    const mutate = async (which: "username" | "password", value: string) => {
      const reply = await input.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: MUTATE,
        arguments: [
          { value: which },
          { value },
          { value: input.origin },
          { value: input.login.username },
        ],
        returnByValue: true,
      });
      if (reply.exceptionDetails) throw new Error("Login input delivery is uncertain.");
      if (reply.result?.value === true) return true;
      if (reply.result?.value === "changed" || reply.result?.value === "account") return false;
      throw new Error("Login input delivery is uncertain.");
    };
    if (!(await mutate("username", input.login.username)))
      return {
        usernameFilled: false,
        passwordFilled: false,
        verdict: "refused" as const,
        code: "form_changed",
      };
    if (!(await mutate("password", input.login.password)))
      return { usernameFilled: true, passwordFilled: false, verdict: "unverifiable" as const };
    const checked = await input
      .send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: READ_BACK,
        arguments: [
          { value: input.origin },
          { value: input.login.username },
          { value: input.login.password },
        ],
        returnByValue: true,
      })
      .catch(() => undefined);
    return {
      usernameFilled: true,
      passwordFilled: true,
      verdict:
        checked !== undefined && !checked.exceptionDetails && checked.result?.value === true
          ? ("confirmed" as const)
          : ("unverifiable" as const),
    };
  } finally {
    await input.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
};
