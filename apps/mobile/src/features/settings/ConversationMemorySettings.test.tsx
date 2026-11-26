import { expect, it } from "vite-plus/test";
import { WS_METHODS, type ServerSettings } from "@goat/contracts";
import {
  createNativeMemoryHarness,
  nativeEnv,
  nativeSpace,
  renderNative,
} from "../../testing/memoryNativeHarness";
import { SettingsMemoryRouteScreen } from "./SettingsMemoryRouteScreen";

it.each([true, false])(
  "uses the selected server's conversation memory capability (%s)",
  async (capable) => {
    const h = createNativeMemoryHarness({
      protocolVersion: 1,
      ...(capable && { conversationMemoryControl: true }),
    });
    h.grant(["memory:read", "settings:write"]);
    const atom = h.configs(nativeEnv);
    const config = h.registry.get(atom)!;
    h.registry.set(atom, {
      ...config,
      settings: { ...config.settings, conversationMemoryEnabled: true, memoryEnabled: false },
    });
    h.responses.set(WS_METHODS.serverUpdateSettings, (input) => {
      const { patch } = input as { patch: Pick<ServerSettings, "conversationMemoryEnabled"> };
      const current = h.registry.get(atom)!;
      const settings = { ...current.settings, ...patch };
      h.registry.set(atom, { ...current, settings });
      return settings;
    });
    const view = renderNative(
      h,
      <SettingsMemoryRouteScreen
        route={{ params: { environmentId: nativeEnv, memorySpaceId: nativeSpace } }}
      />,
    );
    const master = "Use GOAT memory in conversations";
    const toggle = (label: string) =>
      Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
        (el) => el.textContent === label,
      );
    try {
      await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
      await view.render();
      if (!capable) {
        expect(toggle(master)).toBeUndefined();
        expect(toggle("Remember conversations")?.disabled).toBe(false);
        return;
      }
      await view.click(master);
      expect(toggle(master)?.getAttribute("aria-checked")).toBe("false");
      expect(toggle("Remember conversations")?.disabled).toBe(true);
      expect(toggle("Remember conversations")?.getAttribute("aria-checked")).toBe("false");
      expect(toggle("Allow agent memory access")?.disabled).toBe(true);
      expect(toggle("Allow agent memory access")?.getAttribute("aria-checked")).toBe("true");
      expect(view.container.textContent).toContain("Synthetic memory body");
      await view.click(master);
      expect(toggle("Remember conversations")?.disabled).toBe(false);
      expect(toggle("Allow agent memory access")?.disabled).toBe(false);
      expect(
        h.calls.filter((c) => c.method === WS_METHODS.serverUpdateSettings).map((c) => c.input),
      ).toEqual([
        { patch: { conversationMemoryEnabled: false } },
        { patch: { conversationMemoryEnabled: true } },
      ]);
      expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubSettingsUpdate)).toHaveLength(
        0,
      );
    } finally {
      await view.unmount();
      h.dispose();
    }
  },
);
