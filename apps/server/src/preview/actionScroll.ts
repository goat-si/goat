import type { Locator } from "playwright-core";
import { actionCall, remaining, type ReadinessGate } from "./actionReadiness.ts";

export const scrollIntoView = async (locator: Locator, deadline: number, gate: ReadinessGate) => {
  for (;;) {
    await gate();
    gate.signal?.throwIfAborted();
    try {
      return await actionCall(gate, () =>
        locator.scrollIntoViewIfNeeded({ timeout: remaining(deadline) }),
      );
    } catch (cause) {
      if (
        !(
          cause instanceof Error &&
          /^locator\.scrollIntoViewIfNeeded: Element is not attached to the DOM(?:\n|$)/.test(
            cause.message,
          )
        ) ||
        performance.now() >= deadline
      )
        throw cause;
    }
  }
};
