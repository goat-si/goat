import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { matchComposerModelItems } from "./composerModelMentions";
import type { ProviderInstanceEntry } from "../../providerInstances";

describe("composer model mentions", () => {
  it("lists available catalog models and preserves the provider identity", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const entry = {
      instanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      isAvailable: true,
      status: "ready",
    } as ProviderInstanceEntry;
    const items = matchComposerModelItems({
      instanceEntries: [entry],
      modelOptionsByInstance: new Map([[instanceId, [{ slug: "gpt-5.5", name: "GPT-5.5" }]]]),
      query: "",
    });
    expect(items).toEqual([
      expect.objectContaining({ type: "model", instanceId, model: "gpt-5.5" }),
    ]);
  });
});
