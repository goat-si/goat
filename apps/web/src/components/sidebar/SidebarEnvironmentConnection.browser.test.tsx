import type { EnvironmentShellSync } from "@goat/client-runtime/state/presentation";
import { EnvironmentId } from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

let sync: EnvironmentShellSync = "stale";
vi.mock("../../state/presentation", () => ({
  useEnvironmentConnectionPhase: () => "connected",
  useEnvironmentConnectionUnreachable: () => false,
  useEnvironmentShellSync: () => sync,
  useEnvironmentSnapshotCapturedAt: () => null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected", error: null, traceId: null } }),
}));

import {
  SidebarEnvironmentConnectionDot,
  SidebarEnvironmentConnectionStatus,
} from "./SidebarEnvironmentConnection";

it("keeps a connected environment's shell warning visible until its data is live", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const environmentId = EnvironmentId.make("test-environment");
  const render = () =>
    root.render(
      <>
        <SidebarEnvironmentConnectionDot environmentId={environmentId} />
        <SidebarEnvironmentConnectionStatus environmentId={environmentId} />
      </>,
    );
  try {
    for (const state of ["stale", "error"] as const) {
      sync = state;
      await act(render);
      expect(container.querySelector("[aria-label]")).not.toBeNull();
      expect(container.textContent).not.toContain("Connected");
      expect(container.textContent).toMatch(/sync|out of date/i);
    }
    for (const state of ["live", "synchronizing", "cached"] as const) {
      sync = state;
      await act(render);
      expect(container.textContent).toBe("");
      expect(container.querySelector("[aria-label]")).toBeNull();
    }
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
