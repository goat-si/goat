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
export interface ReadinessGate {
  (): void | Promise<void>;
  readonly signal?: AbortSignal | undefined;
  readonly channel?: import("./actionChannel.ts").ActionChannel | undefined;
}
// Cancellation stops continuation; a browser operation already issued cannot be recalled.
export const abortable = async <A>(work: () => Promise<A>, signal?: AbortSignal) => {
  if (!signal) return work();
  if (signal.aborted) throw signal.reason;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
};

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
  gate: ReadinessGate,
) => {
  const ready = async () =>
    (await handle.isVisible()) &&
    (await handle.isEditable().catch((cause: unknown) => {
      throw neverWritable(cause);
    }));
  if (!(await abortable(ready, gate.signal))) {
    readiness.onWaiting?.();
    await abortable(
      () => handle.waitForElementState("visible", { timeout: remaining(deadline) }),
      gate.signal,
    );
    await abortable(
      () =>
        handle
          .waitForElementState("editable", { timeout: remaining(deadline) })
          .catch((cause: unknown) => {
            throw isTimeout(cause) ? notWritable() : cause;
          }),
      gate.signal,
    );
  }
  await revealFramesOf(handle, deadline, gate);
  await gate();
  gate.signal?.throwIfAborted();
  await abortable(
    () => handle.scrollIntoViewIfNeeded({ timeout: remaining(deadline) }),
    gate.signal,
  );
};

/**
 * Brings the frames that hold a target into view, outermost first. An off-screen frame from
 * another site is not rendered, so a target inside it never settles until its frame shows.
 */
export const revealFramesOf = async (
  handle: ElementHandle,
  deadline: number,
  gate?: ReadinessGate,
) => {
  const chain: Array<ElementHandle> = [];
  try {
    for (let frame = await handle.ownerFrame(); frame?.parentFrame(); frame = frame.parentFrame())
      chain.unshift(await frame.frameElement());
    for (const element of chain) {
      await gate?.();
      gate?.signal?.throwIfAborted();
      await abortable(
        () => element.scrollIntoViewIfNeeded({ timeout: remaining(deadline) }),
        gate?.signal,
      );
    }
  } finally {
    for (const element of chain) void element.dispose().catch(() => undefined);
  }
};

/** The element a locator names now, held for the rest of the action. */
export const acquireTarget = async (target: Locator, timeout: number, signal?: AbortSignal) => {
  const pending = target.elementHandle({ timeout });
  let handle: ElementHandle | null;
  try {
    handle = await abortable(() => pending, signal);
  } catch (cause) {
    void pending.then(
      (late) => late?.dispose().catch(() => undefined),
      () => undefined,
    );
    throw cause;
  }
  if (handle === null) throw targetChanged();
  return handle;
};

export const pinTarget = (target: Locator, deadline: number, signal?: AbortSignal) =>
  acquireTarget(target, remaining(deadline), signal);

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
  gate: ReadinessGate,
) => {
  const frame = await abortable(() => handle.ownerFrame(), gate.signal);
  if (frame === null) throw targetChanged();
  if (await abortable(() => frame.evaluate(selectable, [handle, values] as const), gate.signal))
    return true;
  readiness.onWaiting?.();
  try {
    const waiting = frame.waitForFunction(selectable, [handle, values] as const, {
      timeout: remaining(deadline),
    });
    let waiter;
    try {
      waiter = await abortable(() => waiting, gate.signal);
    } catch (cause) {
      void waiting.then(
        (late) => late.dispose().catch(() => undefined),
        () => undefined,
      );
      throw cause;
    }
    void waiter.dispose().catch(() => undefined);
    return true;
  } catch (cause) {
    if (isTimeout(cause)) return false;
    throw cause;
  }
};
