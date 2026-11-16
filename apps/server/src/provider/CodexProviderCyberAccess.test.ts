import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
  type CodexAppServerProviderSnapshot,
} from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it.effect("offers cyber access only on catalog models that advertise it", () =>
  Effect.gen(function* () {
    const catalogModel = (slug: string, cyber?: Array<"standard" | "daybreakBlue">) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: mapCodexModelCapabilities({
        additionalSpeedTiers: [],
        ...(cyber ? { availableAccessPrograms: { cyber } } : {}),
        defaultReasoningEffort: "medium",
        description: slug,
        displayName: slug,
        hidden: false,
        id: slug,
        isDefault: false,
        model: slug,
        supportedReasoningEfforts: [],
      }),
    });
    const defaultPrograms = (snapshot: Partial<CodexAppServerProviderSnapshot>) =>
      checkCodexProviderStatus(decodeCodexSettings({ customModels: ["my-model"] }), () =>
        Effect.succeed({
          version: "1.0.0",
          account: {
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            requiresOpenaiAuth: false,
          },
          models: [
            catalogModel("both", ["standard", "daybreakBlue"]),
            catalogModel("daybreak-only", ["daybreakBlue"]),
            catalogModel("plain"),
          ],
          skills: [],
          ...snapshot,
        } satisfies CodexAppServerProviderSnapshot),
      ).pipe(
        Effect.map((status) =>
          Object.fromEntries(
            status.models.map((model) => {
              const descriptor = model.capabilities?.optionDescriptors?.find(
                (option) => option.id === "cyberAccessProgram",
              );
              return [
                model.slug,
                descriptor?.type === "select" ? (descriptor.currentValue ?? "no default") : null,
              ];
            }),
          ),
        ),
      );

    assert.deepStrictEqual(yield* defaultPrograms({ daybreakEnabled: false }), {
      both: "standard",
      "daybreak-only": "daybreakBlue",
      plain: null,
      "my-model": null,
    });
    assert.deepStrictEqual(yield* defaultPrograms({ daybreakEnabled: true }), {
      both: "daybreakBlue",
      "daybreak-only": "daybreakBlue",
      plain: null,
      "my-model": null,
    });
    // An unread config keeps the choice but cannot know Codex's default.
    assert.deepStrictEqual(yield* defaultPrograms({}), {
      both: "no default",
      "daybreak-only": "no default",
      plain: null,
      "my-model": null,
    });
    assert.deepStrictEqual(
      yield* defaultPrograms({
        account: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
        cyberAccessProgramsUnavailable: true,
      }),
      { both: null, "daybreak-only": null, plain: null, "my-model": null },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
