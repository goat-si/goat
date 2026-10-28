// @effect-diagnostics globalTimers:off - Playwright actions run outside the Effect runtime.
import type { ElementHandle, JSHandle } from "playwright-core";

/**
 * Whether typed text took effect, decided from two bounded reads of the field around the input,
 * kept free of Playwright where it can be so it can be tested.
 */

/** The field just before the input: its value and selection. */
export interface TypedBefore {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** The field just after: its value, and whether a trusted insert reached it during this input. */
export interface TypedAfter {
  readonly value: unknown;
  readonly inserted: boolean;
}

/** A read that has not answered when `expired` settles counts as no answer. */
export const boundedRead = <A>(read: Promise<A>, expired: Promise<void>): Promise<A | undefined> =>
  Promise.race([read.catch(() => undefined), expired.then(() => undefined)]);

/**
 * Confirmed only when this input itself inserted into the field (a trusted insert event, which a
 * cancelled input never fires) and the field now holds exactly what the text makes of its earlier
 * value and selection.
 */
export const typedEffect = (
  before: TypedBefore | undefined,
  text: string,
  after: TypedAfter | undefined,
) => {
  if (!before || !after || text === "" || !after.inserted) return undefined;
  const expected = before.value.slice(0, before.start) + text + before.value.slice(before.end);
  return after.value === expected && after.value !== before.value
    ? { effect: "confirmed" as const, evidence: ["value"] as const }
    : undefined;
};

/** A timer for an action's deadline, on the actions' clock (`performance.now()`). */
export const deadlineExpiry = (deadline: number, now: () => number = () => performance.now()) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((done) => {
    timer = setTimeout(done, Math.max(0, deadline - now()));
  });
  return { expired, clear: () => clearTimeout(timer) };
};

interface PageProbe extends TypedBefore {
  /** Stops listening (idempotent) and reads the field. */
  readonly finish: () => TypedAfter;
}

/** A field being watched for this input; its state lives in a closure the page cannot reach. */
export interface TypedProbe {
  readonly before: TypedBefore;
  readonly handle: JSHandle<PageProbe | undefined>;
}

/**
 * Reads a text field's value and selection just before the input and starts noting whether a
 * trusted insert reaches it. The note is kept in the probe's closure, held only through
 * Playwright's handle (as the click watch is), and the listener removes itself at the deadline.
 */
export const probeBefore = async (
  element: ElementHandle,
  deadline: number,
): Promise<TypedProbe | undefined> => {
  const handle = (await element.evaluateHandle(
    (node, lifetimeMs) => {
      const field = node as unknown as {
        readonly value?: unknown;
        readonly selectionStart?: number | null;
        readonly selectionEnd?: number | null;
        addEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
        removeEventListener(
          type: string,
          listener: (event: unknown) => void,
          capture: boolean,
        ): void;
      };
      if (
        typeof field.value !== "string" ||
        typeof field.selectionStart !== "number" ||
        typeof field.selectionEnd !== "number"
      )
        return undefined;
      let inserted = false;
      let listening = true;
      const listener = (event: unknown) => {
        const fired = event as { readonly isTrusted?: unknown; readonly inputType?: unknown };
        if (fired.isTrusted === true && String(fired.inputType ?? "").startsWith("insert"))
          inserted = true;
      };
      const stop = () => {
        if (listening) field.removeEventListener("input", listener, true);
        listening = false;
      };
      field.addEventListener("input", listener, true);
      setTimeout(stop, lifetimeMs);
      return {
        value: field.value,
        start: field.selectionStart,
        end: field.selectionEnd,
        finish: () => {
          stop();
          return { value: field.value, inserted };
        },
      };
    },
    Math.max(0, deadline - performance.now()),
  )) as JSHandle<PageProbe | undefined>;
  const before = await handle
    .evaluate((probe) =>
      probe ? { value: probe.value, start: probe.start, end: probe.end } : undefined,
    )
    .catch(() => undefined);
  if (before) return { before, handle };
  void handle.dispose().catch(() => undefined);
  return undefined;
};

/** Stops the probe and reads the field after the input. */
export const probeAfter = (probe: TypedProbe): Promise<TypedAfter | undefined> =>
  probe.handle.evaluate((watch) => watch?.finish());

/** Stops a probe that is no longer read (a late answer, a failed input) and lets it go. */
export const retireProbe = (probe: TypedProbe | undefined) => {
  if (!probe) return;
  void probe.handle
    .evaluate((watch) => {
      watch?.finish();
    })
    .catch(() => undefined)
    .finally(() => probe.handle.dispose().catch(() => undefined));
};
