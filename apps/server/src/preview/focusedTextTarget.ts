// @effect-diagnostics globalTimers:off - Playwright work is bounded outside the Effect runtime.
import { constVoid } from "effect/Function";
import type { ElementHandle, Page } from "playwright-core";
import {
  abortable,
  actionCall,
  remaining,
  type Readiness,
  type ReadinessGate,
} from "./actionReadiness.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

type ActiveElement = {
  readonly tagName: string;
  readonly shadowRoot?: { readonly activeElement: ActiveElement | null } | null;
};

// A utility-world locator can hang on desktop. Pin the main-world focus before gating input.
export const pinFocusedTarget = async (page: Page, deadline: number, gate: ReadinessGate) => {
  const timeoutMs = remaining(deadline);
  const pending = actionCall(gate, () =>
    page.evaluateHandle(() => {
      const { document } = globalThis as unknown as {
        document: { activeElement: ActiveElement | null };
      };
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      if (
        element &&
        ["IFRAME", "FRAME", "FENCEDFRAME", "OBJECT", "EMBED"].includes(element.tagName)
      )
        return null;
      return element;
    }),
  );
  let handle: Awaited<typeof pending>;
  try {
    handle = await awaitFocusRead(pending, timeoutMs, gate.signal);
  } catch (cause) {
    void pending.then((late) => late.dispose(), constVoid).catch(constVoid);
    throw cause;
  }
  const element = handle.asElement();
  if (!element) void handle.dispose().catch(constVoid);
  return element;
};

const awaitFocusRead = async <A>(pending: Promise<A>, timeoutMs: number, signal?: AbortSignal) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ServerBrowserOperationError(
            "PreviewAutomationTimeoutError",
            "The page did not report its focused element before the deadline, so no text was typed.",
            { timeoutMs, beforeInput: true },
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await abortable(() => Promise.race([pending, expired]), signal);
  } finally {
    clearTimeout(timer);
  }
};

// Serialized into the page's main world for readiness, focus, and dispatch checks.
export const focusedFieldState = (
  node: unknown,
  phase: "readiness" | "focus" | "clear" | "dispatch" | "range" | void,
) => {
  type Element = {
    readonly tagName: string;
    readonly type?: string;
    readonly isConnected: boolean;
    readonly isContentEditable?: boolean;
    readonly readOnly?: boolean;
    readonly disabled?: boolean;
    readonly parentElement: Element | null;
    readonly assignedSlot?: Element | null;
    matches(selector: string): boolean;
    getAttribute(name: string): string | null;
    getRootNode(): { readonly host?: Element; readonly activeElement?: Element | null };
    getBoundingClientRect(): { readonly width: number; readonly height: number };
    contains(other: Element): boolean;
    focus?: () => void;
  };
  const element = node as Element;
  const disabledByAria = () => {
    for (let ancestor: Element | null = element; ancestor;) {
      const value = ancestor.getAttribute("aria-disabled")?.trim().toLowerCase();
      if (value === "true" || value === "false") return value === "true";
      ancestor =
        ancestor.assignedSlot ?? ancestor.parentElement ?? ancestor.getRootNode().host ?? null;
    }
    return false;
  };
  const blocked = () =>
    element.disabled ||
    element.readOnly ||
    element.matches(":disabled") ||
    disabledByAria() ||
    element.getAttribute("aria-readonly")?.trim().toLowerCase() === "true";
  const input = element.tagName === "INPUT";
  const range = input && element.type === "range";
  const text =
    element.tagName === "TEXTAREA" ||
    (input &&
      ![
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes(element.type ?? "text"));
  const editable = text || element.isContentEditable === true;
  if (phase === undefined || phase === "readiness") {
    if (!element.isConnected || !(editable || range)) return true;
    const { getComputedStyle } = globalThis as unknown as {
      getComputedStyle(element: unknown): { readonly visibility: string };
    };
    const { width, height } = element.getBoundingClientRect();
    return (
      width > 0 && height > 0 && getComputedStyle(element).visibility === "visible" && !blocked()
    );
  }
  if (!element.isConnected || blocked()) return false;
  if (range && (phase === "clear" || phase === "range")) return "range";
  if (!editable) return false;
  if (phase !== "dispatch") element.focus?.();
  const active = element.getRootNode().activeElement;
  return active != null && (active === element || element.contains(active))
    ? text
      ? "text"
      : "editable"
    : false;
};

export const waitUntilFocusedTargetWritable = async (
  page: Page,
  handle: ElementHandle,
  deadline: number,
  readiness: Readiness,
  gate: ReadinessGate,
) => {
  const timeoutMs = remaining(deadline);
  if (
    await awaitFocusRead(
      actionCall(gate, () => handle.evaluate(focusedFieldState, "readiness")),
      timeoutMs,
      gate.signal,
    )
  )
    return;
  readiness.onWaiting?.();
  const pending = actionCall(gate, () =>
    page.waitForFunction(focusedFieldState, handle, { timeout: remaining(deadline) }),
  );
  try {
    const result = await abortable(() => pending, gate.signal);
    void result.dispose().catch(constVoid);
  } catch (cause) {
    void pending.then((late) => late.dispose(), constVoid).catch(constVoid);
    if (cause instanceof Error && cause.name === "TimeoutError")
      throw new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "The field stayed disabled or read-only until the deadline, so no text was typed.",
      );
    throw cause;
  }
};
