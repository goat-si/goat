// @effect-diagnostics globalDate:off - The device transport runs outside Effect.
import type { DeviceHardwareButton } from "./stream.ts";

export function doubleTapHome(send: (button: DeviceHardwareButton) => void) {
  let lastHomePress = -Infinity;
  return (button: DeviceHardwareButton) => {
    const now = Date.now();
    const doubleHome = button === "home" && now - lastHomePress < 400;
    lastHomePress = button === "home" && !doubleHome ? now : -Infinity;
    send(doubleHome ? "appSwitcher" : button);
  };
}
