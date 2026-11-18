// @effect-diagnostics globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
import type { PreviewAutomationWaitForInput } from "@goat/contracts";
import type { Locator, Page } from "playwright-core";
import type { DownloadWait } from "./downloadJournal.ts";
import { extraWaits } from "./waitExtras.ts";
import { matchesState, stateConditions } from "./locatorState.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

export const waitForWithLocator = async (
  targetLocator: (page: Page, input: PreviewAutomationWaitForInput) => Locator | null,
  defaultTimeoutMs: number,
  page: Page,
  input: PreviewAutomationWaitForInput,
  signal?: AbortSignal,
  downloads?: DownloadWait,
) => {
  signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const target = targetLocator(page, input);
  // Legacy presence checks accepted multiple matches, including hidden elements.
  const elementConditions = stateConditions(input);
  // Legacy presence waits take the first of several matches; element conditions need the one.
  const locator =
    input.state === undefined && elementConditions.length === 0 ? target?.first() : target;
  const state = input.state ?? "attached";
  const loadState =
    input.loadState === "domContentLoaded"
      ? "domcontentloaded"
      : input.loadState === "networkIdle"
        ? "networkidle"
        : input.loadState;
  const documentCondition = `(() => (
    ${input.text === undefined ? "true" : `(document.body?.innerText ?? "").includes(${JSON.stringify(input.text)})`}
    && ${input.urlIncludes === undefined ? "true" : `location.href.includes(${JSON.stringify(input.urlIncludes)})`}
  ))()`;
  const extras = extraWaits(page, input, downloads);
  const conditions = [
    ...(locator ? [`locator:${state}`] : []),
    ...elementConditions,
    ...(input.text === undefined ? [] : ["text"]),
    ...(input.urlIncludes === undefined ? [] : ["url"]),
    ...(input.loadState === undefined ? [] : [`load:${input.loadState}`]),
    ...extras.names,
  ];
  const timeout = () =>
    new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      `Waited ${timeoutMs}ms without all conditions holding: ${conditions.join(", ")}.`,
    );
  let stopped = false;
  const remaining = () => {
    signal?.throwIfAborted();
    if (stopped || Date.now() >= deadline) throw timeout();
    return Math.max(1, deadline - Date.now());
  };
  let documentVersion = 0;
  const navigated = (frame: import("playwright-core").Frame) => {
    if (frame === page.mainFrame()) documentVersion++;
  };
  page.on("framenavigated", navigated);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), timeoutMs);
    abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
  });
  const wait = async () => {
    for (;;) {
      // One budget per pass: a deadline passing while the list is built would leave a started wait unobserved.
      const left = remaining();
      await Promise.all([
        locator?.waitFor({ state, timeout: left }),
        ...(input.text === undefined && input.urlIncludes === undefined
          ? []
          : [
              page
                .waitForFunction(documentCondition, undefined, { timeout: left })
                .then((handle) => handle.dispose()),
            ]),
        ...extras.pending(left),
      ]);
      remaining();
      const version = documentVersion;
      // Wait after URL/text resolve so an old document's completed load cannot satisfy a new one.
      if (loadState !== undefined) await page.waitForLoadState(loadState, { timeout: remaining() });
      remaining();
      const [locatorMatches, documentMatches] = await Promise.all([
        locator === null || locator === undefined
          ? true
          : state === "visible"
            ? locator.isVisible()
            : state === "hidden"
              ? locator.isHidden()
              : locator.count().then((count) => (state === "detached" ? count === 0 : count > 0)),
        input.text === undefined && input.urlIncludes === undefined
          ? true
          : page.evaluate(documentCondition).catch((cause: unknown) => {
              // Navigation can destroy the old execution context. Retry only that transition.
              if (
                cause instanceof Error &&
                /execution context was destroyed|cannot find context/i.test(cause.message)
              )
                return false;
              throw cause;
            }),
      ]);
      remaining();
      // Revalidate snapshot refs after a navigation even if the native locator happened to settle.
      if (target) targetLocator(page, input);
      const held =
        (locator && elementConditions.length > 0 && locatorMatches && documentMatches === true
          ? await matchesState(locator, input, remaining())
          : true) && extras.held();
      if (version === documentVersion && locatorMatches && documentMatches === true && held)
        return extras.finish();
      // An element condition has no event to wait on: look again shortly, within the deadline.
      if (!held) await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
    }
  };
  try {
    return await Promise.race([wait(), interrupted]);
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof Error && cause.name === "TimeoutError") throw timeout();
    throw cause;
  } finally {
    // Playwright's read-only wait has no AbortSignal API. It may settle until its deadline,
    // but cannot start another check or hold the control queue after takeover/timeout.
    stopped = true;
    extras.end();
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    page.off("framenavigated", navigated);
  }
};
