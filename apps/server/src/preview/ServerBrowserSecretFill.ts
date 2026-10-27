// @effect-diagnostics globalTimers:off -- The privacy settle wait runs inside a Promise-based browser operation.
/**
 * goat_preview_fill_secret: types an origin-bound secret into a password field of a server browser
 * tab. The value comes from the secret store here and reaches the page only as a CDP argument to a
 * script in an isolated world, so it never passes through the agent, the broker, or Playwright's
 * input and logging path. The isolated world reports the document's real security origin (a
 * sandboxed frame says "null"), and the element it filled is the one it found.
 *
 * While a filled field still holds the value, the tab refuses the agent its own script, image
 * snapshots and recordings; every response from the tab also has the thread's filled values
 * masked, an early warning for page code that echoes them.
 *
 * @module ServerBrowserSecretFill
 */
import {
  PreviewAutomationFillSecretInput,
  type PreviewAutomationFillSecretResult,
  type PreviewAutomationRequest,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CDPSession, Frame, Page } from "playwright-core";

import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";
import {
  BrowserControlInterrupted,
  requireAgentSession,
  type SessionControl,
} from "./SessionControl.ts";

/** The part of a server browser tab this module reads. */
export interface SecretFillTab {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: ReadonlyMap<Frame, CDPSession>;
  readonly control: SessionControl;
  readonly recording: unknown;
  readonly recordingStart: unknown;
}

type RecordAction<T> = <A>(tab: T, action: string, run: () => Promise<A>) => Promise<A>;

const WORLD = "goat-secret-fill";
const MASK = "[secret]";
const MAX_FRAME_DEPTH = 8;
const SETTLE_MS = 1_000;
const REFUSED = "PreviewAutomationSecretFillRefusedError";
const USED_UP =
  "Nothing was filled and the secretRef is used up. Ask the person again with request_secret.";
const FENCED =
  "This tab holds a password GOAT filled. goat_preview_evaluate, image snapshots and recordings stay off until the page submits or navigates.";
const UNCONFIRMED =
  "GOAT cannot confirm the password it filled is gone. Navigate or reload the page first.";

const refused = (message: string) => new ServerBrowserOperationError(REFUSED, message);
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
const FILL = `function (value, origin) {
  if (!(this instanceof HTMLInputElement) || this.type !== "password" || this.disabled ||
    this.readOnly || !this.isConnected || this.ownerDocument !== document || self.origin !== origin)
    return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(this, value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement)
    active = active.shadowRoot.activeElement;
  if (active === this) this.blur();
  return true;
}`;
const STILL_FILLED = "function (value) { return this.isConnected && this.value === value; }";

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

const release = (target: Target) =>
  target.session.send("Runtime.releaseObject", { objectId: target.objectId }).catch(() => {});

const isolatedWorld = async (session: CDPSession, frameId: string) =>
  (await session.send("Page.createIsolatedWorld", { frameId, worldName: WORLD }))
    .executionContextId;

/** The session that owns a frame: this one for in-process frames, else an out-of-process frame's own. */
const sessionForFrame = async (tab: SecretFillTab, session: CDPSession, frameId: string) => {
  try {
    await isolatedWorld(session, frameId);
    return session;
  } catch {
    const candidates = new Set(tab.frameSessions.values());
    for (const frame of tab.page.frames()) {
      if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) continue;
      const opened = await tab.page
        .context()
        .newCDPSession(frame)
        .catch(() => null);
      if (opened) candidates.add(opened);
    }
    for (const candidate of candidates) {
      const tree = await candidate.send("Page.getFrameTree").catch(() => null);
      if (tree?.frameTree.frame.id === frameId) return candidate;
    }
    throw refused("The focused field is in a frame GOAT cannot reach.");
  }
};

/** Finds the password field to fill: the focused one, through frames, or one CSS match in the page. */
const locate = async (tab: SecretFillTab, selector: string | undefined): Promise<Target> => {
  let session = tab.cdp;
  let frameId = (await session.send("Page.getFrameTree")).frameTree.frame.id;
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    const executionContextId = await isolatedWorld(session, frameId);
    const found = await session.send("Runtime.callFunctionOn", {
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
    const { node } = await session.send("DOM.describeNode", { objectId });
    const childFrameId = node.frameId;
    if ((node.nodeName !== "IFRAME" && node.nodeName !== "FRAME") || childFrameId === undefined)
      return { session, objectId };
    await release({ session, objectId });
    session = await sessionForFrame(tab, session, childFrameId);
    frameId = childFrameId;
  }
  throw refused("The focused field is nested too deeply in frames.");
};

const passwordOrigin = async (target: Target) => {
  const checked = await target.session.send("Runtime.callFunctionOn", {
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

const maskWith = (values: ReadonlySet<string>) => (text: string) => {
  let masked = text;
  for (const value of values) masked = masked.split(value).join(MASK);
  return masked;
};

const walk = (value: unknown, mask: (text: string) => string, keys: boolean): unknown => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((each) => walk(each, mask, keys));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [keys ? mask(key) : key, walk(each, mask, keys)]),
  );
};

/** Page-derived JSON can carry a value in its keys; server-built shapes keep theirs. */
const maskResult = (
  operation: PreviewAutomationRequest["operation"],
  result: unknown,
  mask: (text: string) => string,
): unknown => {
  if (operation === "evaluate") return walk(result, mask, true);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    return walk(result, mask, false);
  const record = result as Record<string, unknown>;
  const masked = walk(record, mask, false) as Record<string, unknown>;
  if (operation === "scrollCollect" && Array.isArray(record.items))
    masked.items = walk(record.items, mask, true);
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
  const fences = new WeakMap<Page, Array<Fence>>();

  const consume = (input: {
    readonly ref: PreviewAutomationFillSecretInput["secretRef"];
    readonly threadId: ThreadId;
    readonly origin: string;
  }) =>
    runPromise(
      secretRequests.consumeForOrigin(input).pipe(
        Effect.match({
          onFailure: (error) => ({ error: error.message }),
          onSuccess: (value) => ({ value }),
        }),
      ),
    );

  const fill = async <T extends SecretFillTab>(
    tab: T,
    request: PreviewAutomationRequest,
    deadlineMs: number,
    record: RecordAction<T>,
  ): Promise<PreviewAutomationFillSecretResult> => {
    const input = Option.getOrUndefined(decodeInput(request.input));
    if (input === undefined) throw refused("Pass a secretRef and at most a CSS selector.");
    if (playwrightDebugLogging(process.env.DEBUG))
      throw refused(
        "Browser debug logging (DEBUG) is on, so GOAT will not type secrets. Unset it.",
      );
    requireAgentSession(request);
    const origin = await record(tab, "fillSecret", () =>
      tab.control.secret(
        request.agentSessionId,
        async (fence) => {
          if (tab.recording !== null || tab.recordingStart !== null)
            throw refused("This tab is recording. Stop the recording before filling a password.");
          const target = await locate(tab, input.selector);
          let kept = false;
          let used = false;
          try {
            const destination = await passwordOrigin(target);
            fence.hold();
            fence.assertMayDispatch();
            assertBefore(deadlineMs);
            const consumed = await consume({
              ref: input.secretRef,
              threadId: request.threadId,
              origin: destination,
            });
            if ("error" in consumed) throw refused(consumed.error);
            used = true;
            const value = consumed.value;
            const values = filledValues.get(request.threadId) ?? new Set<string>();
            values.add(value);
            filledValues.set(request.threadId, values);
            fence.assertMayDispatch();
            assertBefore(deadlineMs);
            const typed = await target.session.send("Runtime.callFunctionOn", {
              objectId: target.objectId,
              functionDeclaration: FILL,
              arguments: [{ value }, { value: destination }],
              returnByValue: true,
            });
            if (typed.exceptionDetails || typed.result.value !== true) throw refused(USED_UP);
            const outstanding = fences.get(tab.page) ?? [];
            outstanding.push({ ...target, value });
            fences.set(tab.page, outstanding);
            kept = true;
            return destination;
          } catch (cause) {
            if (!used) throw cause;
            throw refused(
              cause instanceof BrowserControlInterrupted ? `${cause.message} ${USED_UP}` : USED_UP,
            );
          } finally {
            if (!kept) await release(target);
          }
        },
        deadlineMs,
      ),
    );
    return { filled: true, origin, privateMode: await settledPrivate(tab.control) };
  };

  /** Refuses the agent's own script, pixels and recordings while a filled field holds its value. */
  const guard = async (tab: SecretFillTab, request: PreviewAutomationRequest) => {
    const guarded =
      request.operation === "evaluate" ||
      request.operation === "recordingStart" ||
      (request.operation === "snapshot" &&
        (request.input as { readonly captureImage?: boolean } | undefined)?.captureImage !== false);
    const outstanding = fences.get(tab.page);
    if (!guarded || outstanding === undefined || outstanding.length === 0) return;
    let unconfirmed = false;
    const holding: Array<Fence> = [];
    for (const entry of outstanding) {
      const state = await entry.session
        .send("Runtime.callFunctionOn", {
          objectId: entry.objectId,
          functionDeclaration: STILL_FILLED,
          arguments: [{ value: entry.value }],
          returnByValue: true,
        })
        .then(
          (answer) =>
            answer.exceptionDetails ? "unknown" : answer.result.value === true ? "held" : "gone",
          (cause: unknown) => (GONE.test(String(cause)) ? "gone" : "unknown"),
        );
      if (state === "gone") void release(entry);
      else holding.push(entry);
      if (state === "unknown") unconfirmed = true;
    }
    fences.set(tab.page, holding);
    if (holding.length > 0) throw refused(unconfirmed ? UNCONFIRMED : FENCED);
  };

  /** Masks the thread's filled values in everything the tab answers. */
  const mask =
    (request: PreviewAutomationRequest) =>
    <O extends Outcome>(outcome: O): O => {
      const values = filledValues.get(request.threadId);
      if (values === undefined || values.size === 0) return outcome;
      const text = maskWith(values);
      return (
        outcome.ok
          ? { ...outcome, result: maskResult(request.operation, outcome.result, text) }
          : { ...outcome, error: walk(outcome.error, text, false) }
      ) as O;
    };

  return { fill, guard, mask };
});
