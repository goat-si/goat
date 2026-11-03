import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { assignMobileEnvironmentHues, mobileEnvironmentHueKey } from "./environmentHues";

it("leaves the hub neutral and assigns the web hues to remote devices", () => {
  const hues = assignMobileEnvironmentHues(
    ["cloud-sandbox", "headless-1", "headless-2"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      isRelayManaged: false,
    })),
    EnvironmentId.make("headless-2"),
  );
  expect(hues.has("headless-2")).toBe(false);
  expect(hues.get("cloud-sandbox")).toBe("accent-orange-500");
  expect(hues.get("headless-1")).toBe("accent-emerald-500");
});

it("keeps a stored hub with a relay alternate neutral when GOAT Connect is disabled", () => {
  const hub = EnvironmentId.make("headless-2");
  const other = EnvironmentId.make("cloud-sandbox");
  const hues = assignMobileEnvironmentHues(
    [
      { environmentId: other, isRelayManaged: false },
      { environmentId: hub, isRelayManaged: true },
    ],
    hub,
  );
  expect(hues.has(hub)).toBe(false);
  expect(hues.get(other)).toBe("accent-orange-500");
});

it("keeps the hue key stable when connection details change without changing the hub or IDs", () => {
  const hub = EnvironmentId.make("hub");
  const remote = EnvironmentId.make("remote");
  const before = [
    { environmentId: hub, isRelayManaged: false, connectionState: "connected" },
    { environmentId: remote, isRelayManaged: false, connectionState: "connected" },
  ];
  const after = [
    { ...before[1]!, connectionState: "reconnecting", isRelayManaged: true },
    before[0]!,
  ];
  expect(mobileEnvironmentHueKey(before, hub)).toBe(mobileEnvironmentHueKey(after, hub));
});
