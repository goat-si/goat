import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { layerMockSpawner } from "./ProviderRegistry.testkit.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("drops Cursor models a ready catalog read returns none of", () => {
  const previousProvider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    version: "1.0.0",
    models: [{ slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  // Cursor reports ready only once its catalog read completes, so an empty one is authoritative.
  const emptied = { ...previousProvider, checkedAt: "2026-10-30T00:01:00.000Z", models: [] };
  const pending = { ...emptied, status: "warning" } satisfies ServerProvider;

  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, emptied).models,
    [],
  );
  assert.deepStrictEqual(ProviderRegistry.mergeProviderSnapshot(previousProvider, pending).models, [
    ...previousProvider.models,
  ]);
});

it("offers a retained catalog for only the first failed check", () => {
  const ready = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    version: "1.0.0",
    models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  const failed = {
    ...ready,
    status: "error",
    auth: { status: "unknown" },
    models: [],
    checkedAt: "2026-10-30T00:01:00.000Z",
  } as const satisfies ServerProvider;
  const first = ProviderRegistry.mergeProviderSnapshot(ready, failed);
  assert.deepStrictEqual(first.models, ready.models);
  assert.propertyVal(first, "modelsRetained", true);
  assert.propertyVal(ProviderRegistry.mergeProviderSnapshot(first, failed), "modelsRetained", true);
  assert.notProperty(
    ProviderRegistry.mergeProviderSnapshot(first, {
      ...failed,
      checkedAt: "2026-10-30T00:02:00.000Z",
    }),
    "modelsRetained",
  );
  assert.notProperty(ProviderRegistry.mergeProviderSnapshot(first, ready), "modelsRetained");
  assert.notProperty(
    ProviderRegistry.mergeProviderSnapshot(ready, { ...failed, installed: false }),
    "modelsRetained",
  );
  assert.notProperty(
    ProviderRegistry.mergeProviderSnapshot(ready, {
      ...failed,
      auth: { status: "unauthenticated" },
    }),
    "modelsRetained",
  );
});

it("drops a Claude gateway model the same gateway no longer lists (#43603)", () => {
  const auth = {
    status: "authenticated",
    type: "customEndpoint",
    label: "Custom API endpoint",
    endpoint: "http://127.0.0.1:15721",
  } as const;
  const previousProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    status: "ready",
    enabled: true,
    installed: true,
    auth,
    checkedAt: "2026-11-25T00:00:00.000Z",
    version: "2.1.332",
    models: [
      { slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false, capabilities: null },
      {
        slug: "gw--model:free[1m]",
        name: "gw--model:free",
        isCustom: false,
        capabilities: null,
      },
      { slug: "gw--model:free", name: "gw--model:free", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  const refreshedProvider = {
    ...previousProvider,
    checkedAt: "2026-11-26T00:00:00.000Z",
    models: [previousProvider.models[0], previousProvider.models[1]],
  } satisfies ServerProvider;

  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models.map(
      (model) => model.slug,
    ),
    ["claude-sonnet-5-5", "gw--model:free[1m]"],
  );
  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, {
      ...refreshedProvider,
      modelsIncomplete: true,
    }).models.map((model) => model.slug),
    ["claude-sonnet-5-5", "gw--model:free[1m]", "gw--model:free"],
  );
});

it.effect("drops a retired gateway model when the surviving model is configured manually", () =>
  Effect.gen(function* () {
    const surviving = { value: "gateway/current", displayName: "Current", description: "" };
    const retired = { value: "gateway/retired", displayName: "Retired", description: "" };
    const settings = decodeClaudeSettings({
      customModels: [{ slug: surviving.value, name: "My current model" }],
    });
    const environment = {
      ANTHROPIC_BASE_URL: "https://gateway.example",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    };
    const makeCapabilities = (models: ReadonlyArray<typeof surviving>) => () =>
      Effect.succeed({
        tokenSource: "none" as const,
        apiKeySource: "none" as const,
        apiProvider: "firstParty" as const,
        email: undefined,
        subscriptionType: undefined,
        slashCommands: [],
        models,
      });
    const before = yield* checkClaudeProviderStatus(
      settings,
      makeCapabilities([surviving, retired]),
      environment,
    );
    const after = yield* checkClaudeProviderStatus(
      settings,
      makeCapabilities([surviving]),
      environment,
    );
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const driver = ProviderDriverKind.make("claudeAgent");
    const visible = ProviderRegistry.mergeProviderSnapshot(
      { ...before, instanceId, driver },
      { ...after, instanceId, driver },
    );
    assert.include(
      before.models.map((model) => model.slug),
      retired.value,
    );
    assert.deepStrictEqual(
      visible.models
        .filter((model) => model.slug.startsWith("gateway/"))
        .map((model) => model.slug),
      [surviving.value],
    );
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        layerMockSpawner((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "2.1.332\n", stderr: "", code: 0 };
          throw new Error(`Unexpected args: ${joined}`);
        }),
      ),
    ),
  ),
);
