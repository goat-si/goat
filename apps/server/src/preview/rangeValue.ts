import type { ElementHandle } from "playwright-core";

/**
 * Sets a native range input as a person dragging it would: the browser clamps and steps the
 * value, then input and change fire. Confirmed only when the value it accepted survived them.
 */
export const setRange = async (handle: ElementHandle, text: string) => {
  const [accepted, final] = await handle.evaluate((element, value) => {
    const input = element as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set?.call(
      input,
      value,
    );
    const taken = input.value;
    const Event = (
      globalThis as unknown as {
        Event: new (type: string, init: { bubbles: boolean }) => unknown;
      }
    ).Event;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return [taken, input.value] as const;
  }, text);
  return accepted === final
    ? { value: final, effect: "confirmed" as const, evidence: ["value"] }
    : { value: final, effect: "unverifiable" as const, evidence: [] };
};
