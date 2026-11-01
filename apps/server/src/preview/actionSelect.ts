import type { PreviewAutomationSelectInput, PreviewAutomationSelectResult } from "@goat/contracts";
import { constVoid } from "effect/Function";
import type { Page } from "playwright-core";
import {
  actionCall,
  actionDeadline,
  remaining,
  waitUntilSelectable,
  type Readiness,
} from "./actionReadiness.ts";
import { requireEvaluationChannel } from "./actionEvaluation.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import {
  DEFAULT_TIMEOUT_MS,
  elementOf,
  targetLocator,
  type DispatchGate,
} from "./ServerBrowserPage.ts";

const open: DispatchGate = () => {};
const targetChanged = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The target changed or was disabled before the input landed. Take a fresh snapshot and try again.",
  );

export const select = async (
  page: Page,
  input: PreviewAutomationSelectInput,
  gate: DispatchGate = open,
  readiness: Readiness = {},
): Promise<PreviewAutomationSelectResult> => {
  const deadline = actionDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, gate.deadline);
  const locator = targetLocator(page, input);
  if (locator === null)
    throw new ServerBrowserOperationError(
      "PreviewAutomationInvalidSelectorError",
      "A select target is required.",
      { beforeInput: true },
    );
  const handle = await elementOf(locator, remaining(deadline), gate.signal, gate);
  try {
    const ready = await waitUntilSelectable(handle, input.values, deadline, readiness, gate);
    const found = await actionCall(gate, () =>
      handle.evaluate((element) => {
        if (element.tagName !== "SELECT") return null;
        const select = element as unknown as {
          matches(selector: string): boolean;
          readonly multiple: boolean;
          readonly options: ArrayLike<{ value: string; label: string }>;
        };
        return {
          disabled: select.matches(":disabled"),
          multiple: select.multiple,
          options: Array.from(select.options, ({ value, label }) => ({
            value,
            label: label.trim(),
          })),
        };
      }),
    );
    if (found === null)
      throw new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "This element is not a <select>. Click a custom dropdown, then click its option.",
      );
    if (found.disabled && !ready)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This <select> stayed disabled until the deadline, so nothing was selected.",
        { beforeInput: true },
      );
    if (found.disabled) throw targetChanged();
    const values = input.values.map(
      (entry) =>
        (
          found.options.find((option) => option.value === entry) ??
          found.options.find((option) => option.label === entry.trim())
        )?.value,
    );
    const missing = values.indexOf(undefined);
    if (missing !== -1 || (!found.multiple && values.length > 1))
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        missing !== -1
          ? `This <select> ${ready ? "has" : "still has"} no option "${input.values[missing]}"${ready ? "" : " after waiting for it"}.`
          : "This <select> takes one option.",
        { beforeInput: true },
      );
    remaining(deadline);
    await gate();
    gate.signal?.throwIfAborted();
    // What Playwright's selectOption does once the options exist, without its wait for them.
    const selected = await requireEvaluationChannel(gate).call(() =>
      handle.evaluate((element, chosen) => {
        const select = element as unknown as {
          selectedIndex: number;
          readonly options: ArrayLike<{ value: string; selected: boolean }>;
          readonly selectedOptions: ArrayLike<{ value: string }>;
          dispatchEvent(event: unknown): boolean;
        };
        // No values clears the selection, single select included (selectOption's contract).
        select.selectedIndex = -1;
        for (const value of chosen) {
          const option = Array.from(select.options).find((entry) => entry.value === value);
          if (option) option.selected = true;
        }
        const EventType = (
          globalThis as unknown as { Event: new (type: string, init: object) => unknown }
        ).Event;
        select.dispatchEvent(new EventType("input", { bubbles: true, composed: true }));
        select.dispatchEvent(new EventType("change", { bubbles: true }));
        return Array.from(select.selectedOptions, (option) => option.value);
      }, values as ReadonlyArray<string>),
    );
    return { selected };
  } finally {
    if (!gate.signal?.aborted) void requireEvaluationChannel(gate).dispose(handle).catch(constVoid);
  }
};
