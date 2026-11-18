// @effect-diagnostics globalTimers:off - Playwright work is bounded outside the Effect runtime.
import { constVoid } from "effect/Function";
import type { Page } from "playwright-core";
import { abortable, actionCall, remaining, type ReadinessGate } from "./actionReadiness.ts";
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
    const handle = await abortable(() => Promise.race([pending, expired]), gate.signal);
    const element = handle.asElement();
    if (!element) void handle.dispose().catch(constVoid);
    return element;
  } catch (cause) {
    void pending.then((late) => late.dispose(), constVoid).catch(constVoid);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};
