// @effect-diagnostics globalDate:off globalTimers:off - Playwright actions run outside the Effect runtime.
import type { ElementHandle } from "playwright-core";

/**
 * Whether typed text took effect, decided from two bounded reads of the field around the input,
 * kept free of Playwright so it can be tested.
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
 * cancelled input never fires and a page script cannot forge) and the field now holds exactly
 * what the text makes of its earlier value and selection.
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

/** A timer for the action's deadline; `clear` stops it once the reads are done. */
export const deadlineExpiry = (deadline: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((done) => {
    timer = setTimeout(done, Math.max(0, deadline - Date.now()));
  });
  return { expired, clear: () => clearTimeout(timer) };
};

interface ProbedField {
  readonly value?: unknown;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
  addEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: unknown) => void, capture: boolean): void;
  __goatTyped?: { inserted: boolean; listener: (event: unknown) => void };
}

/**
 * Reads a text field's value and selection just before the input, and starts noting whether a
 * trusted insert reaches it. Anything without a text selection is not read.
 */
export const probeBefore = (handle: ElementHandle): Promise<TypedBefore | undefined> =>
  handle.evaluate((element) => {
    const field = element as unknown as ProbedField;
    if (
      typeof field.value !== "string" ||
      typeof field.selectionStart !== "number" ||
      typeof field.selectionEnd !== "number"
    )
      return undefined;
    const probe = {
      inserted: false,
      listener: (event: unknown) => {
        const fired = event as { readonly isTrusted?: boolean; readonly inputType?: string };
        if (fired.isTrusted && String(fired.inputType ?? "").startsWith("insert"))
          probe.inserted = true;
      },
    };
    field.__goatTyped = probe;
    field.addEventListener("input", probe.listener, true);
    return { value: field.value, start: field.selectionStart, end: field.selectionEnd };
  });

/** Reads the field after the input and stops noting inserts. */
export const probeAfter = (handle: ElementHandle): Promise<TypedAfter> =>
  handle.evaluate((element) => {
    const field = element as unknown as ProbedField;
    const probe = field.__goatTyped;
    if (probe) field.removeEventListener("input", probe.listener, true);
    delete field.__goatTyped;
    return { value: field.value, inserted: probe?.inserted === true };
  });
