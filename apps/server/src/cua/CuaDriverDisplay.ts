import * as Option from "effect/Option";
import type * as CuaDisplay from "./CuaDisplayCapability.ts";
import type { CuaX11Display } from "./CuaDriver.ts";

/** The X display among the variables a driver was started with. */
export const x11DisplayOf = (
  environment: ReadonlyArray<CuaDisplay.CuaDisplayVariable>,
): Option.Option<CuaX11Display> => {
  const value = (name: string) => environment.find((variable) => variable.name === name)?.value;
  const display = value("DISPLAY");
  if (display === undefined || display.trim() === "") return Option.none();
  const xauthority = value("XAUTHORITY");
  return Option.some(
    xauthority === undefined ? { DISPLAY: display } : { DISPLAY: display, XAUTHORITY: xauthority },
  );
};
