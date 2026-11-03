import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select: (settings: { agentMemoryLimitGiB: number }) => unknown) =>
    select({ agentMemoryLimitGiB: 8 })) as never,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("./ScopedSwitch"), () => ({ ScopedSwitch: () => null }));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control }) => <div>{control}</div>,
  SettingResetButton: () => null,
}));

import { AgentMemoryLimitSetting } from "./AgentMemoryLimitSetting";

describe("agent memory limit", () => {
  it("saves the typed limit once on blur, never the partial value", async () => {
    state.update.mockReset();
    await using _screen = await render(<AgentMemoryLimitSetting />);
    const input = page.getByRole("spinbutton", { name: "Agent memory limit in GiB" });
    await userEvent.clear(input);
    await userEvent.type(input, "16");
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ agentMemoryLimitGiB: 16 });
  });
});
