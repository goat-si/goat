import type { DispatchGate } from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

export const subsequentClick = async (
  gate: DispatchGate,
  point: { readonly x: number; readonly y: number },
  button: "left" | "middle" | "right",
  clickCount: number,
) => {
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for a multi-click.");
  await channel.mouse.down({ button, clickCount });
  try {
    await channel.mouse.up({ button, clickCount });
  } catch (cause) {
    if (cause instanceof BrowserControlInterrupted || gate.signal?.aborted)
      await channel.releasePressedButton({ ...point, button });
    throw cause;
  }
};
