import { ANTIGRAVITY_DEFAULT_MODEL } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { buildAntigravityModelsFromSession } from "./AntigravityProvider.ts";
import { modelConfig, modelOptions, sessionSetupResult } from "./AntigravityProvider.testkit.ts";

describe("Antigravity model catalog", () => {
  it("uses legacy session models only when model config is absent", () => {
    const fromLegacy = buildAntigravityModelsFromSession({
      models: sessionSetupResult.models,
    });
    expect(fromLegacy).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
    expect(
      buildAntigravityModelsFromSession({
        ...sessionSetupResult,
        configOptions: [{ ...modelConfig, options: [] }],
      }),
    ).toEqual([]);
  });

  it("flattens native option groups without combining distinct model IDs", () => {
    const models = buildAntigravityModelsFromSession({
      configOptions: [
        {
          ...modelConfig,
          currentValue: "gemini-pro-agent",
          options: [
            { groupId: "Flash", name: "Flash", options: [modelOptions[3]!, modelOptions[4]!] },
            { groupId: "Pro", name: "Pro", options: [modelOptions[9]!, modelOptions[3]!] },
          ],
        },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-pro-agent",
    ]);
    expect(models.find((model) => model.isDefault)?.slug).toBe("gemini-pro-agent");
    expect(models.find((model) => model.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL))?.slug).toBe(
      "gemini-pro-agent",
    );
  });

  it("labels models that share a display name with their IDs", () => {
    const models = buildAntigravityModelsFromSession({
      configOptions: [
        {
          ...modelConfig,
          currentValue: "gemini-3.8-flash",
          options: [
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            { value: "gemini-3.8-flash-preview", name: "Gemini 3.8 Flash" },
          ],
        },
      ],
    });
    expect(models.map((model) => model.name)).toEqual([
      "Gemini 3.8 Flash",
      "Gemini 3.8 Flash (gemini-3.8-flash-preview)",
    ]);
  });

  it("offers each model the thinking levels it reported when selected", () => {
    const thinking = (currentValue: string) =>
      ({
        id: "thinking_level",
        name: "Thinking Level",
        category: "thought_level",
        type: "select",
        currentValue,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      }) satisfies EffectAcpSchema.SessionConfigOption;
    const models = buildAntigravityModelsFromSession(
      {
        configOptions: [
          {
            ...modelConfig,
            currentValue: "gemini",
            options: [
              { value: "gemini", name: "Gemini" },
              { value: "claude", name: "Claude" },
              { value: "plain", name: "Plain" },
              { value: "unseen", name: "Unseen" },
            ],
          },
          thinking("high"),
        ],
      },
      new Map([
        ["claude", thinking("low")],
        ["plain", null],
      ]),
    );
    const thinkingOf = (slug: string) =>
      models.find((model) => model.slug === slug)?.capabilities?.optionDescriptors?.[0];

    expect(thinkingOf("gemini")).toMatchObject({ id: "thinking_level", currentValue: "high" });
    expect(thinkingOf("claude")).toMatchObject({ id: "thinking_level", currentValue: "low" });
    expect(thinkingOf("plain")).toBeUndefined();
    expect(thinkingOf("unseen")).toMatchObject({ id: "thinking_level" });
    expect(thinkingOf("unseen")).not.toHaveProperty("currentValue");
  });
});
