/**
 * Waits until a type or select target can take input, within one deadline on the request's
 * clock (performance.now), so nothing is sent after the caller has been answered.
 *
 * @module actionReadiness
 */
import type { ElementHandle, Locator } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

export interface Readiness {
  /** Called once when the first check finds the target not ready, before waiting starts. */
  readonly onWaiting?: (() => void) | undefined;
}

const isTimeout = (cause: unknown) => cause instanceof Error && cause.name === "TimeoutError";

/** Every refusal here comes before input, which the broker reports as not dispatched. */
const beforeInput = { beforeInput: true } as const;

const targetChanged = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The target changed or was disabled before the input landed. Take a fresh snapshot and try again.",
    beforeInput,
  );

const expired = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "The target was not ready before the deadline, so no input was sent.",
    beforeInput,
  );

/** How long a selector may match nothing on a loaded page before an action refuses it. */
const NO_MATCH_GRACE_MS = 2_000;

/**
 * Refuses a target that still matches nothing a short grace after its page loaded, rather than
 * spending the whole wait on it; a target that exists but is not ready yet keeps the full wait.
 */
export const requireMatch = async (target: Locator, timeoutMs: number) => {
  const ends = performance.now() + timeoutMs;
  const left = () => Math.max(1, Math.floor(ends - performance.now()));
  // A target already there needs no wait. After a miss it may still appear: the wait for it runs
  // to the deadline, and the 2 s grace starts only once the page has loaded.
  if ((await target.count()) > 0) return;
  const attached = target
    .first()
    .waitFor({ state: "attached", timeout: left() })
    .then(
      () => true,
      (cause: unknown) => {
        if (isTimeout(cause)) return false;
        throw cause;
      },
    );
  let grace: ReturnType<typeof setTimeout> | undefined;
  const graceOver = target
    .page()
    .waitForLoadState("load", { timeout: left() })
    .then(
      () =>
        new Promise<false>(
          (resolve) => (grace = setTimeout(() => resolve(false), NO_MATCH_GRACE_MS)),
        ),
      // A page that never loads leaves the answer to the wait for the target.
      () => new Promise<false>(() => {}),
    );
  const found = await Promise.race([attached, graceOver]).finally(() => clearTimeout(grace));
  // The wait for the target, left running after a miss, ends by the deadline on its own.
  if (!found)
    throw new ServerBrowserOperationError(
      "PreviewAutomationInvalidSelectorError",
      "No element matches the selector, so no input was sent.",
      { noMatch: true },
    );
};

/** One deadline for the whole action: the request's, narrowed by the action's own timeout. */
export const actionDeadline = (timeoutMs: number, requestDeadline: number | undefined) =>
  Math.min(requestDeadline ?? Number.POSITIVE_INFINITY, performance.now() + timeoutMs);

/** What is left of the deadline; refuses once it has passed, before any wait or input. */
export const remaining = (deadline: number) => {
  const left = Math.floor(deadline - performance.now());
  if (left <= 0) throw expired();
  return left;
};

const notWritable = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTargetNotEditableError",
    "The field stayed disabled or read-only until the deadline, so no text was typed.",
  );

/** Playwright refuses to wait on an element that can never take text, such as a button. */
const neverWritable = (cause: unknown) =>
  cause instanceof Error && /not an <input>|not editable|not an editable/i.test(cause.message)
    ? new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "The target is not an enabled text field, so no text was typed.",
      )
    : cause;

/**
 * Waits for a typing target to be visible and writable, then brings it into view. The caller
 * keeps the same element afterwards, so a focus or render change cannot swap the target.
 */
export const waitUntilWritable = async (
  handle: ElementHandle,
  deadline: number,
  readiness: Readiness,
) => {
  const ready = async () =>
    (await handle.isVisible()) &&
    (await handle.isEditable().catch((cause: unknown) => {
      throw neverWritable(cause);
    }));
  if (!(await ready())) {
    readiness.onWaiting?.();
    await handle.waitForElementState("visible", { timeout: remaining(deadline) });
    await handle
      .waitForElementState("editable", { timeout: remaining(deadline) })
      .catch((cause: unknown) => {
        throw isTimeout(cause) ? notWritable() : cause;
      });
  }
  await revealFramesOf(handle, deadline);
  await handle.scrollIntoViewIfNeeded({ timeout: remaining(deadline) });
};

/**
 * Brings the frames that hold a target into view, outermost first. An off-screen frame from
 * another site is not rendered, so a target inside it never settles until its frame shows.
 */
export const revealFramesOf = async (handle: ElementHandle, deadline: number) => {
  const chain: Array<ElementHandle> = [];
  try {
    for (let frame = await handle.ownerFrame(); frame?.parentFrame(); frame = frame.parentFrame())
      chain.unshift(await frame.frameElement());
    for (const element of chain)
      await element.scrollIntoViewIfNeeded({ timeout: remaining(deadline) });
  } finally {
    for (const element of chain) void element.dispose().catch(() => undefined);
  }
};

/** The element a locator names once something matches it; one that detached is `gone`. */
export const matchedElement = async (target: Locator, timeoutMs: number, gone: () => Error) => {
  const ends = performance.now() + timeoutMs;
  await requireMatch(target, timeoutMs);
  const handle = await target.elementHandle({
    timeout: Math.max(1, Math.floor(ends - performance.now())),
  });
  if (handle === null) throw gone();
  return handle;
};

/** The element a locator names now, held for the rest of the action. */
export const pinTarget = (target: Locator, deadline: number) =>
  matchedElement(target, remaining(deadline), targetChanged);

/** In the select's own frame: enabled (a disabled fieldset counts) and holding every value. */
const selectable = ([element, wanted]: readonly [unknown, ReadonlyArray<string>]) => {
  const select = element as {
    readonly tagName: string;
    matches(selector: string): boolean;
    readonly options: ArrayLike<{ readonly value: string; readonly label: string }>;
  };
  if (select.tagName !== "SELECT") return true;
  const options = Array.from(select.options);
  return (
    !select.matches(":disabled") &&
    wanted.every((value) =>
      options.some((option) => option.value === value || option.label.trim() === value.trim()),
    )
  );
};

/**
 * Waits for a select to be enabled and to hold the requested values. Returns false when the
 * deadline passed first; the caller's own check then says what is still missing.
 */
export const waitUntilSelectable = async (
  handle: ElementHandle,
  values: ReadonlyArray<string>,
  deadline: number,
  readiness: Readiness,
) => {
  const frame = await handle.ownerFrame();
  if (frame === null) throw targetChanged();
  if (await frame.evaluate(selectable, [handle, values] as const)) return true;
  readiness.onWaiting?.();
  try {
    const waiter = await frame.waitForFunction(selectable, [handle, values] as const, {
      timeout: remaining(deadline),
    });
    void waiter.dispose().catch(() => undefined);
    return true;
  } catch (cause) {
    if (isTimeout(cause)) return false;
    throw cause;
  }
};
