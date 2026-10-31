/**
 * Waits until a type or select target can take input, within one deadline on the request's
 * clock (performance.now), so nothing is sent after the caller has been answered.
 *
 * @module actionReadiness
 */
import type { ElementHandle, Locator } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

export interface Readiness {
  /** Called once when the first check finds the target not ready, before waiting starts. */
  readonly onWaiting?: (() => void) | undefined;
}
export interface ReadinessGate {
  (): void | Promise<void>;
  readonly signal?: AbortSignal | undefined;
  readonly channel?: import("./actionChannel.ts").ActionChannel | undefined;
}
export const actionCall = <A>(gate: ReadinessGate | undefined, work: () => A): A => {
  if (!gate) return work();
  if (!gate.channel) throw new Error("An action channel is required for browser commands.");
  return gate.channel.call(work);
};
export const disposeAction = (
  gate: ReadinessGate | undefined,
  handle: { dispose(): Promise<void> },
) => {
  if (!gate?.signal?.aborted) void actionCall(gate, () => handle.dispose()).catch(() => undefined);
};
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

/** How long a selector may match nothing on a loaded page before an action refuses it. */
const NO_MATCH_GRACE_MS = 2_000;
/** How long one look for a missing target lasts while its page is still loading. */
const LOADING_SLICE_MS = 500;

/**
 * Refuses a target that still matches nothing a short grace after its page loaded, rather than
 * spending the whole wait on it; a target that exists but is not ready yet keeps the full wait.
 */
export const requireMatch = async (target: Locator, timeoutMs: number, gate?: ReadinessGate) => {
  const ends = performance.now() + timeoutMs;
  if ((await abortable(() => actionCall(gate, () => target.count()), gate?.signal)) > 0) return;
  for (let graceLeft = NO_MATCH_GRACE_MS; ;) {
    const loaded = await abortable(
      () => actionCall(gate, () => target.page().waitForLoadState("load", { timeout: 1 })),
      gate?.signal,
    ).then(
      () => true,
      (cause: unknown) => {
        if (gate?.signal?.aborted || cause instanceof BrowserControlInterrupted) throw cause;
        return false;
      },
    );
    const slice = Math.min(remaining(ends), loaded ? Math.max(1, graceLeft) : LOADING_SLICE_MS);
    const started = performance.now();
    const found = await abortable(
      () => actionCall(gate, () => target.first().waitFor({ state: "attached", timeout: slice })),
      gate?.signal,
    ).then(
      () => true,
      (cause: unknown) => {
        if (!isTimeout(cause) || performance.now() >= ends) throw cause;
        return false;
      },
    );
    if (found) return;
    if (loaded) graceLeft -= performance.now() - started;
    if (graceLeft <= 0)
      throw new ServerBrowserOperationError(
        "PreviewAutomationInvalidSelectorError",
        "No element matches the selector, so no input was sent.",
        { noMatch: true },
      );
  }
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
  gate: ReadinessGate,
) => {
  const ready = async () =>
    (await actionCall(gate, () => handle.isVisible())) &&
    (await actionCall(gate, () => handle.isEditable()).catch((cause: unknown) => {
      throw neverWritable(cause);
    }));
  if (!(await abortable(ready, gate.signal))) {
    readiness.onWaiting?.();
    await abortable(
      () =>
        actionCall(gate, () =>
          handle.waitForElementState("visible", { timeout: remaining(deadline) }),
        ),
      gate.signal,
    );
    await abortable(
      () =>
        actionCall(gate, () =>
          handle.waitForElementState("editable", { timeout: remaining(deadline) }),
        ).catch((cause: unknown) => {
          throw isTimeout(cause) ? notWritable() : cause;
        }),
      gate.signal,
    );
  }
  await revealFramesOf(handle, deadline, gate);
  await gate();
  gate.signal?.throwIfAborted();
  await abortable(
    () => actionCall(gate, () => handle.scrollIntoViewIfNeeded({ timeout: remaining(deadline) })),
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
    for (
      let frame = await actionCall(gate, () => handle.ownerFrame());
      frame?.parentFrame();
      frame = frame.parentFrame()
    ) {
      const child = frame;
      chain.unshift(await actionCall(gate, () => child.frameElement()));
    }
    for (const element of chain) {
      await gate?.();
      gate?.signal?.throwIfAborted();
      await abortable(
        () =>
          actionCall(gate, () => element.scrollIntoViewIfNeeded({ timeout: remaining(deadline) })),
        gate?.signal,
      );
    }
  } finally {
    for (const element of chain) disposeAction(gate, element);
  }
};

/** The element a locator names after its bounded no-match check. */
export const acquireTarget = async (
  target: Locator,
  timeout: number,
  signal?: AbortSignal,
  gate?: ReadinessGate,
) => {
  const ends = performance.now() + timeout;
  await requireMatch(target, timeout, gate);
  const pending = actionCall(gate, () =>
    target.elementHandle({ timeout: Math.max(1, Math.floor(ends - performance.now())) }),
  );
  let handle: ElementHandle | null;
  try {
    handle = await abortable(() => pending, signal);
  } catch (cause) {
    void pending.then(
      (late) => {
        if (late) disposeAction(gate, late);
      },
      () => undefined,
    );
    throw cause;
  }
  if (handle === null) throw targetChanged();
  return handle;
};

export const pinTarget = (
  target: Locator,
  deadline: number,
  signal?: AbortSignal,
  gate?: ReadinessGate,
) => acquireTarget(target, remaining(deadline), signal, gate);

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
  const frame = await abortable(() => actionCall(gate, () => handle.ownerFrame()), gate.signal);
  if (frame === null) throw targetChanged();
  if (
    await abortable(
      () => actionCall(gate, () => frame.evaluate(selectable, [handle, values] as const)),
      gate.signal,
    )
  )
    return true;
  readiness.onWaiting?.();
  try {
    const waiting = actionCall(gate, () =>
      frame.waitForFunction(selectable, [handle, values] as const, {
        timeout: remaining(deadline),
      }),
    );
    let waiter;
    try {
      waiter = await abortable(() => waiting, gate.signal);
    } catch (cause) {
      void waiting.then(
        (late) => disposeAction(gate, late),
        () => undefined,
      );
      throw cause;
    }
    disposeAction(gate, waiter);
    return true;
  } catch (cause) {
    if (isTimeout(cause)) return false;
    throw cause;
  }
};
