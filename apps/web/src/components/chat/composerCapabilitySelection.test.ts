import type { ComposerCapabilityItem } from "@goat/client-runtime/composerCapabilityItems";
import { ProviderInstanceId, type ProviderDriverKind } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  composerCapabilityTargetDrivers,
  selectComposerCapability,
} from "./composerCapabilitySelection";

const entry = (id: string, driverKind: string) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driverKind: driverKind as ProviderDriverKind,
  }) as ProviderInstanceEntry;
const computer = (
  availability: ComposerCapabilityItem["availability"],
): ComposerCapabilityItem => ({
  id: "capability:computer-use",
  type: "capability",
  capability: "computer-use",
  label: "Computer",
  description: "",
  availability,
});

describe("composer capability selection", () => {
  it("judges the models a fanout actually sends to", () => {
    const entries = [
      entry("cloud", "cursorCloud"),
      entry("codex", "codex"),
      entry("claude", "claudeAgent"),
    ];
    const selections = [
      { instanceId: ProviderInstanceId.make("codex"), model: "a" },
      { instanceId: ProviderInstanceId.make("claude"), model: "b" },
    ];
    expect(composerCapabilityTargetDrivers(selections, entries)).toEqual(["codex", "claudeAgent"]);
  });

  it.each([
    [
      { state: "available", note: null } as const,
      "[Computer](goat-context://v1/capability/capability_computer-use) ",
      false,
    ],
    [{ state: "checking" } as const, null, false],
    [{ state: "unavailable", reason: "plan", setup: false } as const, null, false],
    [{ state: "unavailable", reason: "off", setup: true } as const, "", true],
  ])("picking %o inserts %o and opens setup: %s", (availability, replacement, setup) => {
    const replaceTriggerWith = vi.fn(() => true);
    const openSetup = vi.fn();
    selectComposerCapability({
      item: computer(availability),
      replaceTriggerWith,
      onReplaced: () => {},
      openSetup,
    });
    if (replacement === null) expect(replaceTriggerWith).not.toHaveBeenCalled();
    else expect(replaceTriggerWith).toHaveBeenCalledWith(replacement);
    expect(openSetup).toHaveBeenCalledTimes(setup ? 1 : 0);
  });
});
