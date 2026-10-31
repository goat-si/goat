// @effect-diagnostics globalTimers:off -- The privacy settle wait runs inside a Promise-based browser operation.
/**
 * goat_preview_fill_secret: types an origin-bound secret into a password field over CDP in an
 * isolated world, so the value never passes through the agent, the broker or Playwright's input and
 * log paths. A filled field fences the agent's script, pixels and recordings until it is gone.
 */
import {
  PreviewAutomationFillSecretInput,
  type PreviewAutomationFillSecretResult,
  type PreviewAutomationRequest,
  type PreviewSignInField,
  type PreviewTabSession,
  type SecretRequestFailureReason,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserContext, CDPSession, Frame, Page, Request } from "playwright-core";

import * as SecretRequests from "../secrets/SecretRequests.ts";
import { rememberSecret } from "./pageSecrets.ts";
import {
  compileSecretForms,
  compileSkeletonForms,
  longestForm,
  secretSpans,
  skeletonSpans,
} from "./secretForms.ts";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";
import { makeActionChannel, type ActionChannel } from "./actionChannel.ts";
import { readSignInPage, signInState, type SignInRecord } from "./signInState.ts";

/** The part of a server browser tab this module reads. */
export interface SecretFillTab {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: ReadonlyMap<Frame, CDPSession>;
  readonly control: SessionControl;
  readonly recording: unknown;
  readonly recordingStart: unknown;
  readonly session?: PreviewTabSession;
  /** Moves on each main-frame navigation, so a submission is tied to the document it left. */
  readonly documentGeneration?: number;
}

type RecordAction<T> = <A>(tab: T, action: string, run: () => Promise<A>) => Promise<A>;

const WORLD = "goat-secret-fill";
const MASK = "[secret]";
const MAX_FRAME_DEPTH = 8;
const SETTLE_MS = 1_000;
const REFUSED = "PreviewAutomationSecretFillRefusedError";
const USED_UP =
  "Nothing was filled and the secretRef is used up. Ask the person again with request_secret.";
const UNCERTAIN =
  "GOAT could not confirm whether the password was typed, and the secretRef is used up. Take a text snapshot before asking the person again.";
const FENCED =
  "This tab holds a password GOAT filled. goat_preview_evaluate, image snapshots and recordings stay off until the page submits or navigates, or the field is cleared.";
const SHOWN =
  "This tab shows a password GOAT filled as plain text. Snapshots stay off until the field hides or clears it, or the page navigates.";
const VISUAL =
  "GOAT filled a password on this site in this thread, so image snapshots and recordings of it stay off. A snapshot without includeImage or save still works, as does leaving the site.";
const ACCOUNT_CHANGED =
  "The sign-in form no longer shows the account it showed when GOAT found the field, or not the expectedAccount, so nothing was filled and the secretRef is used up. Check which account the page is for before asking the person again.";
const UNCONFIRMED =
  "GOAT cannot confirm the password it filled is gone. Navigate or reload the page first.";
const SHARED_FENCED =
  "A tab that shares this tab's sign-ins holds a password GOAT filled, so goat_preview_evaluate, image snapshots and recordings here stay off until that field lets go.";
const FILLING =
  "GOAT is filling a password in a tab that shares this tab's sign-ins. Try again once it is done.";
const IMAGE_RACED =
  "GOAT filled a password in a tab that shares this tab's sign-ins while this image was taken, so it was dropped. Take it again.";

type SecretFailure = "no_candidate" | "not_permitted" | "unavailable";

/** A refusal before anything was typed; only UNCERTAIN may have typed the value. */
const refused = (message: string, failure?: SecretFailure) =>
  new ServerBrowserOperationError(
    REFUSED,
    message,
    message === UNCERTAIN
      ? undefined
      : { beforeInput: true, ...(failure ? { secretFailure: failure } : {}) },
  );

/** Why a secretRef could not be used, in the three states a caller can act on. */
const secretFailure = (reason: SecretRequestFailureReason): SecretFailure => {
  switch (reason) {
    case "not_found":
    case "already_answered":
    case "invalid_ref":
    case "ref_unavailable":
    case "ref_expired":
      return "no_candidate";
    case "agent_stopped":
    case "not_a_file_request":
    case "origin_required":
    case "origin_mismatch":
    case "origin_bound":
    case "too_short_for_sign_in":
      return "not_permitted";
    case "load_failed":
    case "store_failed":
    case "record_failed":
    case "read_failed":
    case "consume_failed":
      return "unavailable";
  }
};
const decodeInput = Schema.decodeUnknownOption(PreviewAutomationFillSecretInput);

/** Playwright's protocol log would carry the CDP arguments, so any pattern that could enable it refuses. */
export const playwrightDebugLogging = (debug: string | undefined) =>
  (debug ?? "")
    .split(/[\s,]+/u)
    .some((pattern) => pattern !== "" && !pattern.startsWith("-") && /\*|pw/u.test(pattern));

// Isolated-world scripts: the page's own script cannot replace what they read.
const FOCUSED = `function () {
  let element = document.activeElement;
  while (element && element.shadowRoot && element.shadowRoot.activeElement)
    element = element.shadowRoot.activeElement;
  return element;
}`;
const SELECTED = `function (selector) {
  const found = [];
  const visit = (root) => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  return found.length === 1 ? found[0] : found.length;
}`;
const PASSWORD_ORIGIN = `function () {
  const field = this instanceof HTMLInputElement && this.type === "password" &&
    !this.disabled && !this.readOnly && this.isConnected && this.ownerDocument === document;
  return field ? self.origin : null;
}`;
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
const IDENTIFIER = `function () { return (${IDENTIFIER_OF})(this); }`;
// The name a form request carries the identifier under; null without one or without a name.
const IDENTIFIER_NAME = `function () {
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
const FILL = `function (value, origin, identifier, account) {
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
// Any value left in the field counts: an edit must not lift the fence on most of the password.
// An empty or detached field keeps its entry until its document goes, and then any text field of
// that document holding the value, or four or more characters of it, holds the fence instead.
const STILL_FILLED = `function (value) {
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

interface Target {
  readonly session: CDPSession;
  readonly objectId: string;
}

interface Fence extends Target {
  readonly value: string;
}

const isWebOrigin = (origin: unknown): origin is string =>
  typeof origin === "string" && /^https?:\/\//u.test(origin);

/** Gone means the document or node no longer exists; anything else leaves the fence up. */
const GONE =
  /Cannot find context|context was destroyed|Could not find object|No node with given id/iu;

const release = (target: Target, channel?: ActionChannel) =>
  (channel ? channel.sendFor(target.session) : target.session.send.bind(target.session))(
    "Runtime.releaseObject",
    { objectId: target.objectId },
  ).catch(() => {});

const isolatedWorld = async (session: CDPSession, frameId: string, channel: ActionChannel) =>
  (await channel.sendFor(session)("Page.createIsolatedWorld", { frameId, worldName: WORLD }))
    .executionContextId;

/** The session that owns a frame: this one for in-process frames, else an out-of-process frame's own. */
const sessionForFrame = async (
  tab: SecretFillTab,
  session: CDPSession,
  frameId: string,
  channel: ActionChannel,
) => {
  try {
    await isolatedWorld(session, frameId, channel);
    return session;
  } catch (cause) {
    if (cause instanceof BrowserControlInterrupted) throw cause;
    const candidates = new Set(tab.frameSessions.values());
    for (const frame of tab.page.frames()) {
      if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) continue;
      const opened = await channel.newCDPSession(frame).catch(() => null);
      if (opened) candidates.add(opened);
    }
    for (const candidate of candidates) {
      const tree = await channel
        .sendFor(candidate)("Page.getFrameTree")
        .catch(() => null);
      if (tree?.frameTree.frame.id === frameId) return candidate;
    }
    throw refused("The focused field is in a frame GOAT cannot reach.");
  }
};

/** Finds the password field to fill: the focused one, through frames, or one CSS match in the page. */
const locate = async (
  tab: SecretFillTab,
  selector: string | undefined,
  channel: ActionChannel,
): Promise<Target> => {
  let session = tab.cdp;
  let frameId = (await channel.sendFor(session)("Page.getFrameTree")).frameTree.frame.id;
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    const executionContextId = await isolatedWorld(session, frameId, channel);
    const found = await channel.sendFor(session)("Runtime.callFunctionOn", {
      functionDeclaration: selector === undefined ? FOCUSED : SELECTED,
      executionContextId,
      arguments: selector === undefined ? [] : [{ value: selector }],
      returnByValue: false,
    });
    if (found.exceptionDetails) throw refused("The selector is not valid CSS.");
    const objectId = found.result.objectId;
    if (found.result.subtype !== "node" || objectId === undefined) {
      throw refused(
        selector === undefined
          ? "No password field has focus. Click the field, or pass a selector."
          : "The selector must match exactly one element in the page.",
      );
    }
    if (selector !== undefined) return { session, objectId };
    const { node } = await channel.sendFor(session)("DOM.describeNode", { objectId });
    const childFrameId = node.frameId;
    if ((node.nodeName !== "IFRAME" && node.nodeName !== "FRAME") || childFrameId === undefined)
      return { session, objectId };
    await release({ session, objectId }, channel);
    session = await sessionForFrame(tab, session, childFrameId, channel);
    frameId = childFrameId;
  }
  throw refused("The focused field is nested too deeply in frames.");
};

/** The identifier field's value beside a password field: null when the page has none. */
const identifierOf = async (target: Target, channel: ActionChannel) => {
  const read = await channel.sendFor(target.session)("Runtime.callFunctionOn", {
    objectId: target.objectId,
    functionDeclaration: IDENTIFIER,
    returnByValue: true,
  });
  const value: unknown = read.exceptionDetails ? null : read.result.value;
  return typeof value === "string" ? value : null;
};

/** The name the identifier field is sent under, read where the page's script cannot change it. */
const identifierNameOf = async (target: Target, channel: ActionChannel) => {
  const read = await channel
    .sendFor(target.session)("Runtime.callFunctionOn", {
      objectId: target.objectId,
      functionDeclaration: IDENTIFIER_NAME,
      returnByValue: true,
    })
    .catch(() => null);
  const value: unknown = read && !read.exceptionDetails ? read.result.value : null;
  return typeof value === "string" ? value : null;
};

/**
 * The identifier as the form request itself carries it, so a cancelled submit or another form
 * never speaks for it; unread when the body does not show that field.
 */
const sentIdentifier = (request: Request, name: string | null): PreviewSignInField | "unread" => {
  const body = request.postData();
  if (name === null || body === null) return "unread";
  const type = request.headers()["content-type"] ?? "";
  let value: string | null = null;
  if (type.includes("application/x-www-form-urlencoded"))
    value = new URLSearchParams(body).get(name);
  else if (type.includes("multipart/form-data")) {
    const header = `name="${name}"\r\n\r\n`;
    const start = body.indexOf(header);
    if (start >= 0) value = body.slice(start + header.length).split("\r\n")[0] ?? "";
  }
  if (value === null) return "unread";
  return value.trim() === "" ? "empty" : "filled";
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const VALIDATION_CHARS = 200;

/** A form sent from the top document, or from a frame on the site the password went into. */
const navigates = (request: Request, page: Page, destination: string) => {
  try {
    const frame = request.frame();
    return (
      request.isNavigationRequest() &&
      (frame === page.mainFrame() || originOf(frame.url()) === destination)
    );
  } catch {
    return false;
  }
};

/** Documents that take their creator's origin rather than one from their URL. */
const INHERITED_ORIGIN = /^(?:about:|blob:|$)/u;

/** Whether a request carries a filled value whole, as typed or as a URL, form or JSON encodes it. */
const carriesValue = (text: string, values: ReadonlySet<string>) =>
  [...values].some((value) =>
    [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
    ].some((form) => text.includes(form)),
  );

/** A sign-in request is small; a longer body is checked on its first part only. */
const SIGN_IN_BODY_CHARS = 256 * 1024;

const passwordOrigin = async (target: Target, channel: ActionChannel) => {
  const checked = await channel.sendFor(target.session)("Runtime.callFunctionOn", {
    objectId: target.objectId,
    functionDeclaration: PASSWORD_ORIGIN,
    returnByValue: true,
  });
  const origin: unknown = checked.exceptionDetails ? null : checked.result.value;
  if (origin === null) throw refused("The target is not an enabled password field.");
  if (!isWebOrigin(origin))
    throw refused("The field's page has no web origin, so nothing was filled.");
  return origin;
};

const assertBefore = (deadlineMs: number) => {
  if (performance.now() >= deadlineMs)
    throw new DOMException("The fill ran out of time before it started typing.", "TimeoutError");
};

/** Waits briefly for a blurred field to end private mode, without polling. */
const settledPrivate = (control: SessionControl) =>
  control.isPrivate
    ? new Promise<boolean>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          stop();
          resolve(control.isPrivate);
        };
        const stop = control.onChange(() => {
          if (!control.isPrivate) done();
        });
        const timer = setTimeout(done, SETTLE_MS);
      })
    : Promise.resolve(false);

/** Masks every span any form covers in the original text, so overlapping values all stay hidden. */
const maskWith = (values: ReadonlySet<string>) => {
  const forms = compileSecretForms(values);
  const skeletons = compileSkeletonForms(values);
  const mask = (text: string, cut = false) => {
    const spans = [...secretSpans(text, forms, cut), ...skeletonSpans(text, skeletons, cut)];
    if (spans.length === 0) return text;
    let masked = "";
    let shown = 0;
    let end = -1;
    for (const [start, stop] of spans.toSorted((a, b) => a[0] - b[0])) {
      if (start > end) {
        if (end >= 0) masked += MASK;
        masked += text.slice(shown, start);
      }
      end = Math.max(end, stop);
      shown = end;
    }
    return masked + MASK + text.slice(shown);
  };
  // An echo can be wider than its form (escapes triple it); four times leaves room for that.
  return Object.assign(mask, {
    slack: 4 * longestForm(forms, skeletons.raw, skeletons.decoded),
  });
};

/** Fields GOAT itself fills in its answers; masking one would only corrupt the answer's shape. */
const SERVER_KEYS = new Set([
  "_tag",
  "reason",
  "phase",
  "status",
  "level",
  "requestId",
  "tabId",
  "id",
  "ref",
]);

const walk = (value: unknown, mask: (text: string) => string, keys: boolean): unknown => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((each) => walk(each, mask, keys));
  if (value === null || typeof value !== "object") return value;
  // Page-made JSON (`keys`) is the page's throughout; only server-built shapes keep their fields.
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [
      keys ? mask(key) : key,
      !keys && SERVER_KEYS.has(key) && typeof each === "string" ? each : walk(each, mask, keys),
    ]),
  );
};

/** Page-derived JSON can carry a value in its keys; server-built shapes keep theirs. */
const maskResult = (
  operation: PreviewAutomationRequest["operation"],
  result: unknown,
  mask: (text: string, cut?: boolean) => string,
): unknown => {
  if (operation === "evaluate") return walk(result, mask, true);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    return walk(result, mask, false);
  const record = result as Record<string, unknown>;
  const masked = walk(record, mask, false) as Record<string, unknown>;
  if (operation === "scrollCollect" && Array.isArray(record.items))
    masked.items = walk(record.items, mask, true);
  if (operation === "fetch" && record.truncated === true && typeof record.text === "string")
    masked.text = mask(record.text, true);
  const screenshot = record.screenshot as { readonly data?: unknown } | undefined;
  // Chromium encodes these pixels; text replacement would only corrupt them.
  if (operation === "snapshot" && typeof screenshot?.data === "string")
    masked.screenshot = { ...(masked.screenshot as object), data: screenshot.data };
  return masked;
};

type Outcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly _tag: string;
        readonly message: string;
        readonly detail?: unknown;
      };
    };

export const make = Effect.gen(function* () {
  const secretRequests = yield* SecretRequests.SecretRequests;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const filledValues = new Map<ThreadId, Set<string>>();
  /** Origins a password went into per thread: their pixels may show it after its field is gone. */
  const filledOrigins = new Map<ThreadId, Set<string>>();
  /** Tabs a password went into, a frame of theirs included: their pixels stay off for good. */
  const filledPages = new WeakSet<Page>();
  /** Origins filled per context: every thread's tab of that profile may show what a site stored. */
  const contextOrigins = new WeakMap<BrowserContext, Set<string>>();
  /** Contexts holding such a tab: an about:blank or blob document there may inherit its origin. */
  const filledContexts = new WeakSet<BrowserContext>();
  /** Every tab GOAT acted on, by its context, so a fill sees recordings in that context's tabs. */
  const contextTabs = new WeakMap<BrowserContext, Set<SecretFillTab>>();
  /** Values filled per context: a site may hand them to any thread's tab of that profile. */
  const contextValues = new WeakMap<BrowserContext, Set<string>>();
  /** Fills under way per context: no recording there starts meanwhile. */
  const filling = new WeakMap<BrowserContext, number>();
  /** The field each tab last took a password into, and where it went. */
  const lastFill = new WeakMap<
    Page,
    Target & {
      readonly destination: string;
      /** The name the identifier is sent under; null when the step has none or it has no name. */
      readonly identifierName: string | null;
      /** The step had no identifier field: a password-only step after an earlier one. */
      readonly identifierAbsent: boolean;
    }
  >();
  /** Threads with a tab in a context: a password filled there joins each one's mask at once. */
  const contextThreads = new WeakMap<BrowserContext, Set<ThreadId>>();
  /** Fills started per context, so an image let through before one started is dropped after. */
  const fillEpoch = new WeakMap<BrowserContext, number>();
  /** Image snapshots the guard let through, with the fill count it saw. */
  const imageChecks = new WeakMap<
    PreviewAutomationRequest,
    { readonly tab: SecretFillTab; readonly epoch: number }
  >();
  const track = (tab: SecretFillTab) => {
    const context = tab.page.context();
    const known = contextTabs.get(context) ?? new Set<SecretFillTab>();
    known.add(tab);
    contextTabs.set(context, known);
  };
  /** Holds the context's recordings off while a fill there runs, even before it types. */
  const reserving = async <A>(tab: SecretFillTab, run: () => Promise<A>) => {
    const context = tab.page.context();
    filling.set(context, (filling.get(context) ?? 0) + 1);
    fillEpoch.set(context, (fillEpoch.get(context) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (filling.get(context) ?? 1) - 1;
      if (left > 0) filling.set(context, left);
      else filling.delete(context);
    }
  };
  const addValues = (threadId: ThreadId, added: Iterable<string>) => {
    const values = filledValues.get(threadId) ?? new Set<string>();
    const before = values.size;
    for (const value of added) values.add(value);
    filledValues.set(threadId, values);
    if (values.size !== before) maskers.delete(threadId);
  };
  /** A thread with a tab in a context masks every password filled there, now and later. */
  const joinContext = (threadId: ThreadId, context: BrowserContext) => {
    contextThreads.set(context, (contextThreads.get(context) ?? new Set<ThreadId>()).add(threadId));
    addValues(threadId, contextValues.get(context) ?? []);
  };
  const join = (tab: SecretFillTab, threadId: ThreadId) => {
    track(tab);
    joinContext(threadId, tab.page.context());
  };
  /** A page that took a password, and the popups it or they open, keep their pixels off. */
  const markFilled = (page: Page) => {
    if (filledPages.has(page)) return;
    filledPages.add(page);
    filledContexts.add(page.context());
    page.on("popup", markFilled);
  };
  const signIns = new WeakMap<Page, SignInRecord>();
  const watchedForSignIn = new WeakSet<Page>();
  /** Orders submissions and hand backs; only which came first matters. */
  let signInOrder = 0;
  const noteSignIn = (page: Page, change: Partial<SignInRecord>) =>
    signIns.set(page, { ...signIns.get(page), ...change });
  /**
   * Marks the document a request left from when it carries a password GOAT filled, as a form
   * submission or a script request to the site it went into, and when a person hands the tab
   * back; the sign-in state reads both.
   */
  const watchSignIn = (tab: SecretFillTab, threadId: ThreadId) => {
    if (watchedForSignIn.has(tab.page)) return;
    watchedForSignIn.add(tab.page);
    tab.page.on("request", (request) => {
      if (request.method() === "GET" || request.method() === "HEAD") return;
      const field = lastFill.get(tab.page);
      if (field === undefined) return;
      const kind = request.resourceType();
      const form = kind === "document" && navigates(request, tab.page, field.destination);
      const script =
        (kind === "xhr" || kind === "fetch") && originOf(request.url()) === field.destination;
      if (!form && !script) return;
      const values = filledValues.get(threadId);
      const carried =
        request.url() + "\n" + (request.postData() ?? "").slice(0, SIGN_IN_BODY_CHARS);
      if (values === undefined || !carriesValue(carried, values)) return;
      const at = ++signInOrder;
      // Read from the request itself; a script request's identifier is never read.
      const identifier = !form
        ? "unread"
        : field.identifierAbsent
          ? "absent"
          : sentIdentifier(request, field.identifierName);
      noteSignIn(tab.page, {
        submitted: {
          documentGeneration: tab.documentGeneration ?? 0,
          at,
          kind: form ? "form" : "script",
          identifier,
        },
      });
      void request.response().then((response) => {
        const submitted = signIns.get(tab.page)?.submitted;
        if (response && submitted?.at === at)
          noteSignIn(tab.page, { submitted: { ...submitted, status: response.status() } });
      }, constVoid);
    });
    tab.control.onHandoffChange((end) => {
      if (end === "handedBack") noteSignIn(tab.page, { handedBackAt: ++signInOrder });
    });
  };
  const fences = new WeakMap<Page, Array<Fence>>();
  // A frame's session closes with its document: whatever it filled there is gone.
  const closedSessions = new WeakSet<CDPSession>();
  const watchedSessions = new WeakSet<CDPSession>();
  const watch = (session: CDPSession) => {
    if (watchedSessions.has(session)) return;
    watchedSessions.add(session);
    session.on("close", () => closedSessions.add(session));
  };
  // Compiled once per thread and dropped when the thread fills another value.
  const maskers = new Map<ThreadId, ReturnType<typeof maskWith>>();
  const maskerFor = (threadId: ThreadId) => {
    const values = filledValues.get(threadId);
    if (values === undefined || values.size === 0) return undefined;
    const known = maskers.get(threadId);
    if (known !== undefined) return known;
    const compiled = maskWith(values);
    maskers.set(threadId, compiled);
    return compiled;
  };

  const consume = (input: {
    readonly ref: PreviewAutomationFillSecretInput["secretRef"];
    readonly threadId: ThreadId;
    readonly origin: string;
  }) =>
    runPromise(
      secretRequests.consumeForOrigin(input).pipe(
        Effect.match({
          onFailure: (error) => ({ error: error.message, failure: secretFailure(error.reason) }),
          onSuccess: (value) => ({ value }),
        }),
      ),
    );

  const fill = async <T extends SecretFillTab>(
    tab: T,
    request: PreviewAutomationRequest,
    deadlineMs: number,
    record: RecordAction<T>,
    checkBlocked: ((destination: string) => Promise<void>) & {
      readonly isFenced: () => boolean;
      readonly blockedFrame: () => boolean;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<PreviewAutomationFillSecretResult> => {
    const input = Option.getOrUndefined(decodeInput(request.input));
    if (input === undefined) throw refused("Pass a secretRef and at most a CSS selector.");
    if (playwrightDebugLogging(process.env.DEBUG))
      throw refused(
        "Browser debug logging (DEBUG) is on, so GOAT will not type secrets. Unset it.",
      );
    SessionControl.requireAgentSession(request);
    const filled = await record(tab, "fillSecret", () =>
      tab.control.secret(
        request.agentSessionId,
        (fence) =>
          reserving(tab, async () => {
            checkBlocked.signal?.throwIfAborted();
            await checkBlocked(tab.page.url());
            checkBlocked.signal?.throwIfAborted();
            fence.assertMayDispatch();
            const channel = makeActionChannel({
              cdp: tab.cdp,
              page: tab.page,
              signal: checkBlocked.signal
                ? AbortSignal.any([fence.signal, checkBlocked.signal])
                : fence.signal,
              controlGeneration: fence.assertMayDispatch,
              isFenced: checkBlocked.isFenced,
              blockedFrame: checkBlocked.blockedFrame,
            });
            track(tab);
            const recording = [...(contextTabs.get(tab.page.context()) ?? [])].some(
              (each) => each.recording !== null || each.recordingStart !== null,
            );
            if (recording)
              throw refused(
                "A tab that shares this tab's sign-ins is recording. Stop the recording before filling a password.",
              );
            const target = await locate(tab, input.selector, channel);
            let kept = false;
            let used = false;
            try {
              const destination = await passwordOrigin(target, channel);
              const identifier = await identifierOf(target, channel);
              const identifierName =
                identifier === null ? null : await identifierNameOf(target, channel);
              fence.hold();
              await checkBlocked(destination);
              checkBlocked.signal?.throwIfAborted();
              fence.assertMayDispatch();
              assertBefore(deadlineMs);
              const consumed = await consume({
                ref: input.secretRef,
                threadId: request.threadId,
                origin: destination,
              });
              if ("error" in consumed) throw refused(consumed.error, consumed.failure);
              used = true;
              const value = consumed.value;
              // Every thread with a tab sharing these sign-ins masks it, answers under way too.
              const shares = tab.page.context();
              contextValues.set(
                shares,
                (contextValues.get(shares) ?? new Set<string>()).add(value),
              );
              joinContext(request.threadId, shares);
              for (const each of contextThreads.get(shares) ?? []) addValues(each, [value]);
              rememberSecret(tab.page, value);
              // Before typing: a lost reply may still have typed it, and its pixels stay off.
              const origins = filledOrigins.get(request.threadId) ?? new Set<string>();
              origins.add(destination);
              filledOrigins.set(request.threadId, origins);
              const shared = contextOrigins.get(tab.page.context()) ?? new Set<string>();
              shared.add(destination);
              contextOrigins.set(tab.page.context(), shared);
              markFilled(tab.page);
              // Watching before the value goes in: its own input handler may submit at once.
              lastFill.set(tab.page, {
                ...target,
                destination,
                identifierName,
                identifierAbsent: identifier === null,
              });
              watchSignIn(tab, request.threadId);
              await checkBlocked(destination);
              checkBlocked.signal?.throwIfAborted();
              fence.assertMayDispatch();
              assertBefore(deadlineMs);
              // Fenced before dispatch: a lost reply may still have typed the value.
              const entry: Fence = { ...target, value };
              watch(target.session);
              const outstanding = fences.get(tab.page) ?? [];
              outstanding.push(entry);
              fences.set(tab.page, outstanding);
              kept = true;
              const typed = await channel
                .sendFor(target.session)("Runtime.callFunctionOn", {
                  objectId: target.objectId,
                  functionDeclaration: FILL,
                  arguments: [
                    { value },
                    { value: destination },
                    { value: identifier },
                    { value: input.expectedAccount ?? null },
                  ],
                  returnByValue: true,
                })
                .catch(() => {
                  throw refused(UNCERTAIN);
                });
              // Only FILL's explicit early answers prove the value was never set.
              if (typed.exceptionDetails || typed.result.value !== true) {
                const early = typed.result.value === false || typed.result.value === "account";
                if (typed.exceptionDetails || !early) throw refused(UNCERTAIN);
                fences.set(
                  tab.page,
                  (fences.get(tab.page) ?? []).filter((each) => each !== entry),
                );
                kept = false;
                throw refused(typed.result.value === "account" ? ACCOUNT_CHANGED : USED_UP);
              }
              return { destination, verified: input.expectedAccount !== undefined };
            } catch (cause) {
              if (cause instanceof BrowserControlInterrupted && cause.reason === "blocked_url")
                throw cause;
              if (!used || (cause instanceof ServerBrowserOperationError && cause.tag === REFUSED))
                throw cause;
              throw refused(
                cause instanceof BrowserControlInterrupted
                  ? `${cause.message} ${USED_UP}`
                  : USED_UP,
              );
            } finally {
              if (!kept && !fence.signal.aborted) await release(target, channel);
            }
          }),
        deadlineMs,
      ),
    );
    return {
      filled: true,
      origin: filled.destination,
      privateMode: await settledPrivate(tab.control),
      account: filled.verified ? "matched" : "unverified",
    };
  };

  /** Whether a tab may show a password GOAT filled in pixels: its site, or a fill under way, says no. */
  const pixelsOff = (tab: SecretFillTab, threadId: ThreadId) => {
    if ((filling.get(tab.page.context()) ?? 0) > 0) return FILLING;
    const origins = filledOrigins.get(threadId);
    const shared = contextOrigins.get(tab.page.context());
    const inherits = filledContexts.has(tab.page.context());
    const shows = (url: string) =>
      origins?.has(originOf(url)) === true ||
      shared?.has(originOf(url)) === true ||
      (inherits && INHERITED_ORIGIN.test(url));
    return filledPages.has(tab.page) || tab.page.frames().some((frame) => shows(frame.url()))
      ? VISUAL
      : null;
  };

  /**
   * Refuses where a recording starts, after the tab is marked as starting one: a fill checks that
   * mark after reserving its context, so whichever comes second refuses.
   */
  const assertPixels = (tab: SecretFillTab, threadId: ThreadId) => {
    const off = pixelsOff(tab, threadId);
    if (off !== null) throw refused(off);
  };

  /** Checks the fields GOAT filled on a page, dropping those that let go. */
  const fenceState = async (page: Page) => {
    let unconfirmed = false;
    let shown = false;
    let holding = false;
    const kept: Array<Fence> = [];
    for (const entry of fences.get(page) ?? []) {
      const state = closedSessions.has(entry.session)
        ? "gone"
        : await entry.session
            .send("Runtime.callFunctionOn", {
              objectId: entry.objectId,
              functionDeclaration: STILL_FILLED,
              arguments: [{ value: entry.value }],
              returnByValue: true,
            })
            .then(
              (answer): unknown => (answer.exceptionDetails ? "unknown" : answer.result.value),
              (cause: unknown) => (GONE.test(String(cause)) ? "gone" : "unknown"),
            );
      if (state === "gone") void release(entry);
      else kept.push(entry);
      if (state === "gone" || state === "empty") continue;
      holding = true;
      if (state === "shown") shown = true;
      else if (state !== "hidden") unconfirmed = true;
    }
    fences.set(page, kept);
    return { unconfirmed, shown, holding };
  };

  /**
   * Refuses the agent's own script, pixels and recordings while a filled field holds a value, in
   * this tab or one sharing its sign-ins, and text snapshots too once that value shows as plain text.
   */
  const guard = async (tab: SecretFillTab, request: PreviewAutomationRequest) => {
    join(tab, request.threadId);
    const textSnapshot =
      request.operation === "snapshot" &&
      (request.input as { readonly captureImage?: boolean } | undefined)?.captureImage === false;
    if (request.operation === "snapshot" && !textSnapshot)
      imageChecks.set(request, { tab, epoch: fillEpoch.get(tab.page.context()) ?? 0 });
    const guarded =
      request.operation === "evaluate" ||
      request.operation === "recordingStart" ||
      (request.operation === "snapshot" && !textSnapshot);
    const visual =
      request.operation === "recordingStart" || (request.operation === "snapshot" && !textSnapshot);
    if (!guarded && !textSnapshot) return;
    const own = await fenceState(tab.page);
    // A text snapshot hides password inputs itself; a value shown as plain text, or a field GOAT
    // cannot check, stops it.
    if (textSnapshot ? own.shown || own.unconfirmed : own.holding)
      throw refused(own.unconfirmed ? UNCONFIRMED : own.shown ? SHOWN : FENCED);
    if (textSnapshot) return;
    const sharing = contextTabs.get(tab.page.context()) ?? new Set<SecretFillTab>();
    for (const other of sharing) {
      if (other.page.isClosed()) sharing.delete(other);
      else if (other.page !== tab.page && (await fenceState(other.page)).holding)
        throw refused(SHARED_FENCED);
    }
    // Pixels of a site it filled a password on stay off after the field lets go, too.
    if (visual) assertPixels(tab, request.threadId);
  };

  /** Masks the thread's filled values in everything the tab answers. */
  const mask =
    (request: PreviewAutomationRequest) =>
    <O extends Outcome>(outcome: O): O => {
      // A fill that started in the context after the guard let the image through drops it.
      const image = imageChecks.get(request);
      if (image !== undefined && outcome.ok) {
        const raced = (fillEpoch.get(image.tab.page.context()) ?? 0) !== image.epoch;
        const off = raced ? IMAGE_RACED : pixelsOff(image.tab, request.threadId);
        if (off !== null) {
          const error = refused(off);
          return { ok: false, error: { _tag: error.tag, message: error.message } } as O;
        }
      }
      const text = maskerFor(request.threadId);
      if (text === undefined) return outcome;
      return (
        outcome.ok
          ? { ...outcome, result: maskResult(request.operation, outcome.result, text) }
          : { ...outcome, error: walk(outcome.error, text, false) }
      ) as O;
    };

  /**
   * Masks the thread's filled values in one text. With `limit`, a text the caller will cut there is
   * cut first a little past it and masked as cut, so a huge page text is never scanned whole.
   */
  const maskText = (threadId: string, page?: Pick<Page, "context">) => {
    const thread = ThreadId.make(threadId);
    // A tab's own records mask what any thread fills in its context from the start.
    if (page !== undefined) joinContext(thread, page.context());
    return (text: string, limit?: number) => {
      const masker = maskerFor(thread);
      if (masker === undefined) return text;
      if (limit === undefined || text.length <= limit + masker.slack) return masker(text);
      return masker(text.slice(0, limit + masker.slack), true);
    };
  };

  /** The tab's sign-in facts, from the page and from what GOAT saw it send. */
  const signInStateOf = async (tab: SecretFillTab, threadId: ThreadId) => {
    const page = await readSignInPage(tab);
    // Masked before the cut, so a cut never leaves the start of a value.
    const masked = page.validation.map((text) => maskText(threadId)(text, VALIDATION_CHARS));
    return signInState(
      { ...page, validation: masked.map((text) => text.slice(0, VALIDATION_CHARS)) },
      signIns.get(tab.page) ?? {},
      tab.documentGeneration ?? 0,
      tab.session,
    );
  };

  return { fill, guard, assertPixels, mask, maskText, signInState: signInStateOf };
});
