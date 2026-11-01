import { EnvironmentId } from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ScopedMobileSettingsTarget } from "../settings-scoped-server";

vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/SettingsRow", () => ({
  SettingsRow: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
import { AllowedApps } from "./AllowedApps";

it("sends each selected app identity without a stale full settings list", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const id = EnvironmentId.make("env:allowed-apps");
  const target = {
    environment: { environmentId: id, label: "Host" },
    settings: { cuaAllowedApps: ["A", "B"] },
  } as unknown as ScopedMobileSettingsTarget;
  const remove = vi.fn();
  act(() => root.render(<AllowedApps targets={[target]} disabled={false} onRemove={remove} />));
  const buttons = container.querySelectorAll("button");
  act(() => {
    buttons[0]?.click();
    buttons[1]?.click();
  });
  expect(remove.mock.calls).toEqual([
    [id, "A"],
    [id, "B"],
  ]);
  act(() => root.unmount());
});
