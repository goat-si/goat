import { describe, expect, it, vi } from "vite-plus/test";

import { createTrayMenuGate, menuUpdatesWhileOpen } from "./trayMenuGate.ts";

const EMPTY = { attention: [], running: [], pinned: [] };

describe("createTrayMenuGate", () => {
  it("holds a menu change until the menu closes", () => {
    const apply = vi.fn();
    const gate = createTrayMenuGate<string>("A", apply, false);
    gate.opened();
    gate.update("B");
    expect(apply).not.toHaveBeenCalled();
    gate.closed();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("B");
  });

  it("applies an unchanged menu only once", () => {
    const apply = vi.fn();
    const gate = createTrayMenuGate<string>("seed", apply, false);
    gate.update("A");
    gate.update("A");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("A");
  });

  it("reapplies the initial menu before any update", () => {
    const apply = vi.fn();
    createTrayMenuGate(EMPTY, apply, false).reapply();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(EMPTY);
  });

  it("applies while open only when the platform draws the menu live", () => {
    const apply = vi.fn();
    const gate = createTrayMenuGate<string>("A", apply, true);
    gate.opened();
    gate.update("B");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("B");
    expect(menuUpdatesWhileOpen("linux")).toBe(true);
    expect(menuUpdatesWhileOpen("darwin")).toBe(false);
    expect(menuUpdatesWhileOpen("win32")).toBe(false);
  });
});
