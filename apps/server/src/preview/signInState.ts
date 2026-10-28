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
  /** Frames GOAT could not read, so a sign-in form there may be missed. */
  readonly unreadableFrames: number;
}

/** What GOAT recorded on this tab. */
export interface SignInRecord {
  /**
   * A form or same-site script request from the tab carried a password GOAT filled, while this
   * document was showing.
   */
  readonly submitted?: {
    readonly documentGeneration: number;
    readonly at: number;
    /** The HTTP status the submission got back, once it did. */
    readonly status?: number;
    /** A form the page sent, or a script request, which GOAT cannot tell from other traffic. */
    readonly kind?: "form" | "script";
    /** The identifier as the form request carried it; unread when the request does not show it. */
    readonly identifier?: PreviewSignInField | "unread";
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
    // Never cut here: a cut text could keep the start of a password the server must mask whole.
    if (text.trim() && visible(el))
      validation.push(text.length > 20000 ? "[a message too long to read]" : text.trim());
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

type FrameNode = {
  readonly frame: { readonly id: string };
  readonly childFrames?: ReadonlyArray<FrameNode>;
};
const frameIds = (node: FrameNode): ReadonlyArray<string> => [
  node.frame.id,
  ...(node.childFrames ?? []).flatMap(frameIds),
];

const readFrame = async (sessions: ReadonlyArray<CDPSession>, frameId: string) => {
  for (const session of sessions) {
    const world = await session
      .send("Page.createIsolatedWorld", { frameId, worldName: WORLD })
      .catch(() => null);
    if (world === null) continue;
    const answer = await session
      .send("Runtime.evaluate", {
        expression: "(" + PAGE_FACTS + ")()",
        contextId: world.executionContextId,
        returnByValue: true,
      })
      .catch(() => null);
    if (answer && !answer.exceptionDetails)
      return answer.result.value as Omit<SignInPage, "unreadableFrames">;
  }
  return null;
};

/**
 * Reads every frame's sign-in facts where the page's own script cannot change them; a password
 * can go into a frame. The frame with a sign-in form speaks for the tab, the top one otherwise.
 */
export const readSignInPage = async (tab: {
  readonly cdp: CDPSession;
  readonly frameSessions: ReadonlyMap<unknown, CDPSession>;
}): Promise<SignInPage> => {
  const { frameTree } = await tab.cdp.send("Page.getFrameTree");
  const sessions = [tab.cdp, ...tab.frameSessions.values()];
  const read = await Promise.all(frameIds(frameTree).map((id) => readFrame(sessions, id)));
  const facts = read.filter((each) => each !== null);
  const top = read[0];
  if (top === null || top === undefined)
    throw new Error("GOAT could not read the page's sign-in state.");
  const form = facts.find((each) => each.signIn) ?? top;
  return {
    ...form,
    validation: facts.flatMap((each) => each.validation).slice(0, 3),
    humanStep: facts.find((each) => each.humanStep !== null)?.humanStep ?? null,
    accountChoices: Math.max(...facts.map((each) => each.accountChoices)),
    unreadableFrames: read.length - facts.length,
  };
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
  const failed = submitted?.status !== undefined && submitted.status >= 400;
  if (failed)
    return {
      stage: "validation_error",
      evidence: [...evidence, "the site answered " + submitted.status],
    };
  if (page.humanStep) return { stage: "human_step", evidence };
  if (page.validation.length > 0 && (page.signIn || submitted !== undefined))
    return { stage: "validation_error", evidence };
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
  if (page.unreadableFrames > 0)
    return {
      stage: "unknown",
      evidence: [...evidence, "a frame GOAT could not read may hold the form"],
    };
  if (submitted?.identifier === "empty")
    return {
      stage: "partial",
      evidence: [...evidence, "the identifier was empty when the password was sent"],
    };
  if (submitted?.identifier === "unread")
    return {
      stage: "unknown",
      evidence: [...evidence, "GOAT could not read the identifier as the password was sent"],
    };
  if (submitted?.kind !== "form")
    return {
      stage: "unknown",
      evidence: [
        ...evidence,
        "a script request carried it, which GOAT cannot tell from other traffic",
      ],
    };
  // A later page alone is no answer: the site must have taken the submission itself.
  if (submitted?.status === undefined)
    return { stage: "unknown", evidence: [...evidence, "the site has not answered it"] };
  const answered = [...evidence, "the site answered " + submitted.status];
  if (record.handedBackAt !== undefined && record.handedBackAt > submitted.at)
    return { stage: "signed_in", evidence: [...answered, "a person handed the tab back after it"] };
  return { stage: "site_accepted", evidence: [...answered, "no sign-in form or error shows now"] };
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
