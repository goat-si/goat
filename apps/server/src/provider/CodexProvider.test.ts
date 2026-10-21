import * as CodexErrors from "effect-codex-app-server/errors";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HomeRoute from "./OpenCodexRoute.ts";
import { fixture as routeFixture } from "./OpenCodexRoute.testkit.ts";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
import { assert, it } from "@effect/vitest";

import { applyPreferredCodexDefaultModel, mapCodexModelCapabilities } from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

const ROUTED_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const overrides = {};
for (const arg of process.argv.slice(2)) {
  const match = /^(model_provider|openai_base_url|model_catalog_json)=(.*)$/.exec(arg);
  if (match) overrides[match[1]] = JSON.parse(match[2]);
}
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  if (method === "initialize") result = { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" };
  else if (method === "config/read") result = { config: overrides, origins: {} };
  else if (method === "account/read") { fs.appendFileSync(process.env.CODEX_HOME + "/account-observed", JSON.stringify(overrides)); result = { account: null, requiresOpenaiAuth: false }; }
  else if (method === "skills/list") result = { data: [] };
  else if (method === "model/list") result = { data: [], nextCursor: null };
  else { write({ id, error: { code: -32601, message: "unsupported" } }); return; }
  write({ id, result });
});`;
it.effect.each(["missing", "changed"])(
  "uses the actual selected binary config/catalog/account for a source-derived Home with %s Child credentials",
  (credential) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* routeFixture({ role: "home", credential });
      const binary = `${fixture.input.execution.home}/selected-codex`;
      yield* fs.writeFileString(binary, ROUTED_CODEX);
      yield* fs.chmod(binary, 0o755);
      const snapshot = yield* checkCodexProviderStatus(
        { ...fixture.input.settings, binaryPath: binary },
        undefined,
        {},
      ).pipe(Effect.provideService(HomeRoute.OpenCodexRoute, fixture.service));
      assert.equal(snapshot.codexRoute?.state, "home");
      assert.equal(snapshot.codexRoute?.effectiveBaseUrl, fixture.input.settings.opencodexBaseUrl);
      const account = yield* fs.readFileString(`${fixture.input.execution.home}/account-observed`);
      assert.include(account, fixture.catalog);
      assert.include(account, fixture.input.settings.opencodexBaseUrl);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a failed Codex config probe never publishes the inspect-only endpoint as effective",
  () =>
    Effect.gen(function* () {
      const fixture = yield* routeFixture({ role: "home" });
      const snapshot = yield* checkCodexProviderStatus(
        fixture.input.settings,
        () =>
          Effect.fail(
            new CodexErrors.CodexAppServerSpawnError({
              command: "fixture-codex",
              cause: new Error("fixture probe failure"),
            }),
          ),
        {},
      ).pipe(Effect.provideService(HomeRoute.OpenCodexRoute, fixture.service));
      assert.equal(snapshot.codexRoute?.state, "home");
      assert.isUndefined(snapshot.codexRoute?.effectiveBaseUrl);
      assert.equal(snapshot.status, "error");
    }).pipe(Effect.provide(NodeServices.layer)),
);
