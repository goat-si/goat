import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ update: vi.fn(), value: 8 as number | null }));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select: (settings: { agentMemoryLimitGiB: number | null }) => unknown) =>
    select({ agentMemoryLimitGiB: state.value })) as never,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("./ScopedSwitch"), () => ({
  ScopedSwitch: (({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => <button onClick={() => onCheckedChange(!checked)}>Automatic</button>) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control }) => <div>{control}</div>,
  SettingResetButton: () => <></>,
}));

import { AgentMemoryLimitSetting } from "./AgentMemoryLimitSetting";

describe("agent memory limit", () => {
  it("saves the typed limit once on blur, never the partial value", async () => {
    state.update.mockReset();
    state.value = 8;
    await using _screen = await render(<AgentMemoryLimitSetting />);
    const input = page.getByRole("spinbutton", { name: "Agent memory limit in GiB" });
    await userEvent.clear(input);
    await userEvent.type(input, "16");
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(state.update).toHaveBeenCalledExactlyOnceWith(
      { agentMemoryLimitGiB: 16 },
      { onFailed: expect.any(Function) },
    );
  });

  it("restores the saved limit when an update is rejected", async () => {
    state.value = 8;
    state.update.mockReset().mockImplementation((_patch, options) => options?.onFailed?.());
    await using _screen = await render(<AgentMemoryLimitSetting />);
    const input = page.getByRole("spinbutton", { name: "Agent memory limit in GiB" });
    await userEvent.clear(input);
    await userEvent.type(input, "16");
    await userEvent.tab();
    await expect.element(input).toHaveValue(8);
  });

  it("shows Auto until automatic is switched off", async () => {
    state.value = null;
    state.update.mockReset();
    await using screen = await render(<AgentMemoryLimitSetting />);
    const input = page.getByRole("spinbutton", { name: "Agent memory limit in GiB" });
    await expect.element(input).toHaveValue(null);
    await expect.element(input).toHaveAttribute("placeholder", "Auto");
    await expect.element(input).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Automatic" }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ agentMemoryLimitGiB: 16 });
    state.value = 16;
    await screen.rerender(<AgentMemoryLimitSetting />);
    await expect.element(input).toHaveValue(16);
    await expect.element(input).toBeEnabled();
  });
});
