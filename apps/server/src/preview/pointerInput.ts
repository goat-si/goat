/**
 * Pointer input at viewport points rather than elements, for maps and canvases that have none.
 *
 * @module pointerInput
 */
import type { Page } from "playwright-core";
import { remaining, type ReadinessGate } from "./actionReadiness.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

type Point = { readonly x: number; readonly y: number };

/**
 * Before each input after the first: an earlier one can open a dialog that holds the page past
 * the caller's deadline, or a person can take the tab, and then the rest must not go out.
 */
const again = async (gate: ReadinessGate, deadline: number) => {
  if (performance.now() >= deadline)
    throw new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      "The deadline passed partway through the pointer input, so the rest was not sent.",
    );
  await gate();
  gate.signal?.throwIfAborted();
};

/** Presses at `from`, moves in `steps` to `to`, releases; each input passes the gate first. */
export const dragBetween = async (
  page: Page,
  input: { readonly from: Point; readonly to: Point; readonly steps?: number | undefined },
  gate: ReadinessGate,
  deadline: number,
) => {
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for pointer input.");
  const steps = input.steps ?? 10;
  const cdp = await channel.newCDPSession(page);
  const send = channel.sendFor(cdp);
  let cut = false;
  try {
    remaining(deadline);
    await gate();
    gate.signal?.throwIfAborted();
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...input.from });
    await again(gate, deadline);
    let held = false;
    try {
      const pressing = send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...input.from,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      held = true;
      await pressing;
      for (let step = 1; step <= steps; step++) {
        const along = (from: number, to: number) => from + ((to - from) * step) / steps;
        await again(gate, deadline);
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: along(input.from.x, input.to.x),
          y: along(input.from.y, input.to.y),
          button: "left",
          buttons: 1,
        });
      }
      await again(gate, deadline);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...input.to,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      held = false;
    } catch (cause) {
      if (held && (cause instanceof BrowserControlInterrupted || gate.signal?.aborted)) {
        cut = true;
        await channel.resetPressedInput(input.from, cdp);
      } else if (held) {
        try {
          await send("Input.cancelDragging");
        } finally {
          await send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...input.from,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
        }
      }
      throw cause;
    }
  } finally {
    if (!cut && !gate.signal?.aborted) await channel.detach(cdp);
  }
};

/** A real wheel at a point goes to whatever is under it, which page script can zoom on. */
export const wheelAt = async (
  _page: Page,
  at: Point,
  delta: readonly [number, number],
  gate: ReadinessGate,
  deadline: number,
) => {
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for pointer input.");
  remaining(deadline);
  await gate();
  gate.signal?.throwIfAborted();
  await channel.mouse.move(at.x, at.y);
  await again(gate, deadline);
  await channel.mouse.wheel(delta[0], delta[1]);
};

type Box = Point & { readonly width: number; readonly height: number };

/** Whether a box lies wholly in view; scrolling waits a frame even when nothing moves. */
export const inViewport = (box: Box | null, viewport: { width: number; height: number } | null) =>
  box !== null &&
  viewport !== null &&
  box.x >= 0 &&
  box.y >= 0 &&
  box.x + box.width <= viewport.width &&
  box.y + box.height <= viewport.height;
