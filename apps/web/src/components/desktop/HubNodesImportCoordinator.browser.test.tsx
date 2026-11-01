import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ importNodes: vi.fn(), environmentId: "", permitted: true }));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }) },
  };
});
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: state.environmentId,
    connection: { phase: "connected" },
  }),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { importHubNodes: { permissionAtom: () => Atom.make(state.permitted) } },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.importNodes }));
import { HubNodesImportCoordinator } from "./HubNodesImportCoordinator";

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.environmentId = expect.getState().currentTestName!;
  state.permitted = true;
  state.importNodes.mockReset();
  (window as { desktopBridge?: unknown }).desktopBridge = {};
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.restoreAllMocks();
});

it("skips unsupported imports without a warning and does not retry on rerender", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.importNodes.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.die("Unknown request tag: hub.nodes.import"),
  });
  await act(async () => root.render(<HubNodesImportCoordinator />));
  await act(async () => root.render(<HubNodesImportCoordinator />));
  expect(state.importNodes).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});

it("keeps warnings for real import failures", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.importNodes.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Storage unavailable")),
  });
  await act(async () => root.render(<HubNodesImportCoordinator />));
  expect(warn).toHaveBeenCalledOnce();
});

it("does not import without permission", async () => {
  state.permitted = false;
  await act(async () => root.render(<HubNodesImportCoordinator />));
  expect(state.importNodes).not.toHaveBeenCalled();
});
