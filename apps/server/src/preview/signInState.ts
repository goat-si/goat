/**
 * What GOAT can see of a sign-in on a tab: the page's own facts, read in an isolated world, and
 * what GOAT recorded itself (a request that carried a password it filled, a person's hand back).
 * A stage never claims more than those facts show: completion needs a person's confirmation.
 */
import type {
  PreviewAutomationSignInState,
  PreviewSignInField,
  PreviewSignInStage,
  PreviewTabSession,
} from "@goat/contracts";
import type { CDPSession } from "playwright-core";

const WORLD = "goat-sign-in-state";

/** Read from the page; texts are cut short and masked by the caller like every answer. */
export interface SignInPage {
  readonly origin: string | null;
  readonly signIn: boolean;
  readonly identifier: PreviewSignInField;
  readonly password: PreviewSignInField;
  readonly validation: ReadonlyArray<string>;
  readonly humanStep: "captcha" | "mfa" | null;
  readonly accountChoices: number;
}

/** What GOAT recorded on this tab. */
export interface SignInRecord {
  /** A request from the tab carried a password GOAT filled, while this document was showing. */
  readonly submitted?: {
    readonly documentGeneration: number;
    readonly at: number;
    /** The HTTP status the submission got back, once it did. */
    readonly status?: number;
  };
  /** When, in the same order as submitted.at, a person last handed the tab back after GOAT asked them to finish a step. */
  readonly handedBackAt?: number;
}

const PAGE_FACTS = String.raw`function () {
  const visible = (el) =>
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
    getComputedStyle(el).visibility !== "hidden";
  const all = (root, selector) => {
    const found = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...all(el.shadowRoot, selector));
    return found;
  };
  const passwords = all(document, "input[type=password]").filter((f) => visible(f) && !f.disabled);
  const current = passwords.filter((f) => (f.autocomplete || "").toLowerCase() !== "new-password");
  const signIn = passwords.length === 1 && current.length === 1;
  let identifier = "absent";
  let password = "absent";
  const validation = [];
  if (signIn) {
    const field = current[0];
    password = field.value ? "filled" : "empty";
    const scope = field.form || field.closest("form") || document;
    const named = (input) => /username|email/i.test(input.autocomplete || "");
    const candidates = all(scope, "input").filter(
      (input) => input !== field && visible(input) && !input.disabled &&
        (["text", "email", "tel"].includes(input.type) || named(input)),
    );
    const before = candidates.filter((input) => input.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING);
    const id = candidates.find(named) || before[before.length - 1];
    if (id) identifier = id.value.trim() ? "filled" : "empty";
  }
  // Errors count with or without a form: a failed sign-in often shows no form at all.
  const scope = signIn ? current[0].form || current[0].closest("form") || document : document;
  for (const el of all(scope, "[aria-invalid=true], [role=alert]")) {
    const text = (el.getAttribute("aria-invalid") === "true" ? el.validationMessage : el.innerText) || "";
    if (text.trim() && visible(el)) validation.push(text.trim().slice(0, 4000));
    if (validation.length >= 3) break;
  }
  const frames = all(document, "iframe").map((frame) => frame.src || "");
  const captcha =
    frames.some((src) => /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile/i.test(src)) ||
    all(document, ".g-recaptcha, .h-captcha, .cf-turnstile").length > 0;
  const mfa = all(document, "input").some(
    (input) => visible(input) &&
      (/one-time-code/i.test(input.autocomplete || "") ||
        /\b(otp|totp|2fa|mfa)\b|verification.?code/i.test((input.name || "") + " " + (input.id || ""))),
  );
  const email = /[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/i;
  const choices = new Set();
  for (const el of all(document, "button, [role=button], [role=option], [role=menuitem], a:not([href^='mailto:'])")) {
    if (!visible(el)) continue;
    const match = (el.innerText || "").match(email);
    if (match) choices.add(match[0].toLowerCase());
  }
  return {
    origin: /^https?:/.test(self.origin) ? self.origin : null,
    signIn, identifier, password, validation,
    humanStep: captcha ? "captcha" : mfa ? "mfa" : null,
    accountChoices: choices.size,
  };
}`;

/** Reads the main document's sign-in facts where the page's own script cannot change them. */
export const readSignInPage = async (cdp: CDPSession): Promise<SignInPage> => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: WORLD,
  });
  const answer = await cdp.send("Runtime.evaluate", {
    expression: "(" + PAGE_FACTS + ")()",
    contextId: executionContextId,
    returnByValue: true,
  });
  if (answer.exceptionDetails) throw new Error("GOAT could not read the page's sign-in state.");
  return answer.result.value as SignInPage;
};

/**
 * The stage these facts support, checked in order. Completion is never inferred from the page:
 * a request that carried the password, then a new document without a sign-in form, is only
 * site_accepted until a person hands the tab back after it.
 */
export const signInStage = (
  page: SignInPage,
  record: SignInRecord,
  documentGeneration: number,
): { readonly stage: PreviewSignInStage; readonly evidence: ReadonlyArray<string> } => {
  const submitted = record.submitted;
  const here = submitted !== undefined && submitted.documentGeneration === documentGeneration;
  const later = submitted !== undefined && submitted.documentGeneration < documentGeneration;
  const evidence = [
    ...(submitted ? ["a request carried the password GOAT filled"] : []),
    ...(later ? ["the page changed after it"] : []),
  ];
  if (page.humanStep) return { stage: "human_step", evidence };
  const failed = submitted?.status !== undefined && submitted.status >= 400;
  if (failed || (page.validation.length > 0 && (page.signIn || submitted !== undefined)))
    return {
      stage: "validation_error",
      evidence: failed ? [...evidence, "the site answered " + submitted.status] : evidence,
    };
  if (page.accountChoices >= 2)
    return {
      stage: "account_choice",
      evidence: [...evidence, "the page offers more than one account"],
    };
  if (page.signIn) {
    if (here) return { stage: "submitted", evidence };
    if (page.password === "filled" && page.identifier === "empty")
      return { stage: "partial", evidence };
    if (page.password === "filled") return { stage: "fields_applied", evidence };
    return { stage: "form_present", evidence };
  }
  if (here) return { stage: "submitted", evidence };
  if (!later) return { stage: "unknown", evidence };
  if (record.handedBackAt !== undefined && submitted && record.handedBackAt > submitted.at)
    return { stage: "signed_in", evidence: [...evidence, "a person handed the tab back after it"] };
  return { stage: "site_accepted", evidence: [...evidence, "no sign-in form or error shows now"] };
};

export const signInState = (
  page: SignInPage,
  record: SignInRecord,
  documentGeneration: number,
  session: PreviewTabSession | undefined,
): PreviewAutomationSignInState => {
  const { stage, evidence } = signInStage(page, record, documentGeneration);
  return {
    stage,
    origin: page.origin,
    ...(session ? { session } : {}),
    fields: { identifier: page.identifier, password: page.password },
    submitted: record.submitted !== undefined,
    ...(page.humanStep ? { humanStep: page.humanStep } : {}),
    validation: page.validation.slice(0, 3),
    evidence: evidence.slice(0, 8),
  };
};
