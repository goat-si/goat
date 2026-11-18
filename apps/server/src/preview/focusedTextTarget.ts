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

// Both checks run in the main world of the pinned element.
const focusedTargetReady = (node: unknown) => {
  const element = node as {
    readonly tagName: string;
    readonly isConnected: boolean;
    readonly isContentEditable?: boolean;
    readonly readOnly?: boolean;
    matches(selector: string): boolean;
    getBoundingClientRect(): { readonly width: number; readonly height: number };
  };
  if (!element.isConnected) return true;
  if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA" && !element.isContentEditable)
    return true;
  const { getComputedStyle } = globalThis as unknown as {
    getComputedStyle(element: unknown): { readonly visibility: string };
  };
  const { width, height } = element.getBoundingClientRect();
  return (
    width > 0 &&
    height > 0 &&
    getComputedStyle(element).visibility === "visible" &&
    !element.readOnly &&
    !element.matches(":disabled")
  );
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
      actionCall(gate, () => handle.evaluate(focusedTargetReady)),
      timeoutMs,
      gate.signal,
    )
  )
    return;
  readiness.onWaiting?.();
  const pending = actionCall(gate, () =>
    page.waitForFunction(focusedTargetReady, handle, { timeout: remaining(deadline) }),
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
