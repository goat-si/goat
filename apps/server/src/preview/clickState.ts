import type { Locator, Page } from "playwright-core";
import { constVoid } from "effect/Function";
import { actionCall, type ReadinessGate } from "./actionReadiness.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import type { ClickEffect } from "./clickEffect.ts";

/** What a click reports: the effect it saw, presses a dialog cut short, and with checked the state. */
export type ClickReport = Partial<ClickEffect> & {
  readonly pressesCompleted?: number;
  readonly pressed?: boolean;
  readonly checked?: boolean;
};

/** Whether a checkbox, radio or switch is checked; any other control is refused before input. */
const readChecked = (locator: Locator, gate: ReadinessGate, timeout: number) =>
  actionCall(gate, () => locator.isChecked({ timeout })).catch((cause: unknown) => {
    if (cause instanceof Error && /not a checkbox or radio button/i.test(cause.message))
      throw new ServerBrowserOperationError(
        "PreviewAutomationInvalidSelectorError",
        "checked needs a checkbox, radio or switch, and this target is none of them; nothing was sent.",
      );
    if (cause instanceof Error && cause.name === "TimeoutError")
      throw new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        "The target was not found before the deadline, so no input was sent.",
        { beforeInput: true },
      );
    throw cause;
  });

/** How long the read after the click may take: the control is already on the page. */
const READ_BACK_MS = 1_000;

/**
 * Clicks only when the control is not already in the wanted state, then reads it back, as
 * Playwright's check() does. A click that opened a dialog or left the page cannot be read back.
 */
export const clickToState = async <
  R extends { readonly evidence: ReadonlyArray<string>; readonly pressesCompleted?: number },
>(
  locator: Locator | null,
  wanted: boolean,
  gate: ReadinessGate,
  timeout: number,
  press: () => Promise<R>,
): Promise<
  | R
  | (R & { readonly pressed: true; readonly checked?: boolean })
  | { readonly pressed: false; readonly checked: boolean }
> => {
  if (locator === null)
    throw new ServerBrowserOperationError(
      "PreviewAutomationInvalidSelectorError",
      "checked needs a locator or selector; nothing was sent.",
    );
  if ((await readChecked(locator, gate, timeout)) === wanted)
    return { pressed: false, checked: wanted };
  const result = await press();
  // A dialog a held key opened stopped the click itself: the keys went out, the click did not.
  if (result.pressesCompleted === 0) return result;
  if (result.evidence.includes("dialog") || result.evidence.includes("navigation"))
    return { ...result, pressed: true };
  const after = await readChecked(locator, gate, READ_BACK_MS).catch(() => undefined);
  if (after !== wanted)
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      after === undefined
        ? "The click was sent but the control could not be read back; observe before retrying."
        : `The click was sent but the control is still ${after ? "checked" : "unchecked"}; observe before retrying.`,
    );
  return { ...result, pressed: true, checked: after };
};

/**
 * Modifier keys held for one click: each goes down through the gate's channel right before the
 * first press and comes up on release, which skips the channel as a pointer reset does, so a
 * Stop, a fence or an error never leaves a key held on the page.
 */
export const heldKeys = (page: Page, gate: ReadinessGate, keys: ReadonlyArray<string> = []) => {
  const down: string[] = [];
  let releasing = false;
  return {
    press: async () => {
      for (const key of keys)
        await actionCall(gate, () => {
          // A press still waiting behind a dialog must not hold keys after their release.
          if (releasing) return;
          down.push(key);
          return page.keyboard.down(key);
        });
    },
    /** Behind a dialog a key-up waits until it is answered, as the press does, so it lingers. */
    release: async (behindDialog: boolean, linger?: (work: Promise<unknown>) => void) => {
      releasing = true;
      const released = Promise.all(
        down
          .splice(0)
          .reverse()
          .map((key) => page.keyboard.up(key).catch(constVoid)),
      );
      if (behindDialog) linger?.(released);
      else await released;
    },
  };
};
