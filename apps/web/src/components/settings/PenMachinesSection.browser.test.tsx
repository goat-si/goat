import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ showPenMachines: true }),
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      <span>{description}</span>
      {control}
    </div>
  ),
}));
import { PenMachinesView } from "./PenMachinesSection";
import { penGuidance, penLiveStatus } from "./PenMachinesSection.logic";

const setup = () => state.update.mockReset();

it("shows each member's state and installs only when a person chooses Set up", async () => {
  setup();
  const onSetUp = vi.fn();
  const onRetry = vi.fn();
  await using screen = await render(
    <PenMachinesView
      statuses={[
        { nodeId: "1", name: "Ready", state: "connected" },
        { nodeId: "2", name: "New", state: "not-set-up" },
        { nodeId: "3", name: "Old", state: "needs-update" },
        { nodeId: "4", name: "Failed", state: "failed" },
      ]}
      guidance={null}
      onRetry={onRetry}
      onSetUp={onSetUp}
    />,
  );
  await expect.element(screen.getByText("Connected")).toBeVisible();
  await expect.element(screen.getByText(/GOAT not set up/)).toBeVisible();
  await expect.element(screen.getByText(/Update GOAT on that machine/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Set up" }).elements()).toHaveLength(1);
  expect(onSetUp).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Set up" }));
  expect(onSetUp).toHaveBeenCalledWith("2");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledWith("4");
});

it("the switch writes the setting", async () => {
  setup();
  await using screen = await render(
    <PenMachinesView statuses={[]} guidance={null} onRetry={() => {}} onSetUp={() => {}} />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Show my Pen machines" }));
  expect(state.update).toHaveBeenCalledWith({ showPenMachines: false });
});

it("says what to do when Pen has written no ssh hosts", () => {
  const refused = {
    nodeId: "1",
    name: "box",
    state: "refused",
    refusal: "not-in-pen-config",
  } as const;
  const ready = {
    kind: "ready",
    seq: 1,
    meshId: "m".repeat(26),
    selfNodeId: "s".repeat(26),
    members: [
      {
        nodeId: "a".repeat(26),
        name: "box",
        online: true,
        noisePub: "A".repeat(43),
        route: { kind: "refused", reason: "not-in-pen-config" },
      },
    ],
  } as const;
  expect(penGuidance(ready, [refused])).toContain("pen ssh-config --install");
  expect(penGuidance(ready, [{ nodeId: "1", name: "box", state: "connected" }])).toBeNull();
  expect(penGuidance({ kind: "disabled" }, [])).toBeNull();
  expect(penGuidance({ kind: "unavailable", seq: 1, reason: "daemon-down" }, [])).toContain(
    "pen up",
  );
});

it("a connected row follows its live connection, not the last member list", () => {
  const row = { nodeId: "1", name: "box", state: "connecting" } as const;
  expect(penLiveStatus(row, { phase: "connected" }).state).toBe("connected");
  expect(penLiveStatus({ ...row, state: "connected" }, { phase: "connecting" }).state).toBe(
    "connecting",
  );
  expect(penLiveStatus(row, { phase: "reconnecting", unreachable: true }).state).toBe("offline");
  expect(
    penLiveStatus(row, {
      phase: "error",
      failure: { kind: "blocked", detail: "That host reaches another machine." },
    }),
  ).toMatchObject({ state: "failed", detail: "That host reaches another machine." });
  // A row GOAT is not connected through keeps what discovery found.
  expect(
    penLiveStatus({ nodeId: "2", name: "new", state: "not-set-up" }, { phase: "connected" }).state,
  ).toBe("not-set-up");
});
