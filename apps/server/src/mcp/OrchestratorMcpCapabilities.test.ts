import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";

import { listCapabilityModels } from "./OrchestratorMcpCapabilities.ts";

const providerWith = (slugs: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-23T00:00:00.000Z",
  models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

const search = (provider: ServerProvider, terms: ReadonlyArray<string>) =>
  listCapabilityModels({
    provider,
    preferences: undefined,
    isPinned: () => false,
    searchTerms: terms,
  });

describe("listCapabilityModels", () => {
  it("lists an exact slug match above the truncation cap", () => {
    // Ten rows match the term and the exact slug sorts last in the user's order.
    const provider = providerWith([
      "probe-01",
      "probe-02",
      "probe-03",
      "probe-04",
      "probe-05",
      "probe-06",
      "probe-07",
      "probe-08",
      "probe-09",
      "probe",
    ]);
    const { listed, omitted } = search(provider, ["probe"]);
    assert.strictEqual(listed[0]?.slug, "probe");
    assert.deepStrictEqual(
      listed.map((model) => model.slug),
      [
        "probe",
        "probe-01",
        "probe-02",
        "probe-03",
        "probe-04",
        "probe-05",
        "probe-06",
        "probe-07",
        "probe-08",
      ],
    );
    assert.strictEqual(omitted, 1);
  });

  it("still caps the listing when no slug matches exactly", () => {
    const provider = providerWith([
      "probe-01",
      "probe-02",
      "probe-03",
      "probe-04",
      "probe-05",
      "probe-06",
      "probe-07",
      "probe-08",
      "probe-09",
      "probe-10",
    ]);
    const { listed, omitted } = search(provider, ["probe"]);
    assert.strictEqual(listed.length, 8);
    assert.strictEqual(omitted, 2);
  });
});
