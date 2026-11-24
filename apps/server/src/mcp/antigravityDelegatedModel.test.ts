import { expect, it } from "@effect/vitest";
import type { ServerProvider } from "@goat/contracts";
import { antigravityDelegatedModel, delegatedOptions } from "./antigravityDelegatedModel.ts";

it("recognizes an advertised Antigravity model's thinking suffix", () => {
  const provider = {
    driver: "antigravity",
    models: [
      {
        slug: "gemini-4-neon",
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              role: "reasoning",
              type: "select",
              options: [{ id: "high" }, { id: "medium" }],
            },
          ],
        },
      },
    ],
  } as unknown as ServerProvider;
  expect(antigravityDelegatedModel(provider, "gemini-4-neon-high")).toEqual({
    model: "gemini-4-neon",
    thinking: { id: "thought_level", value: "high" },
  });
  expect(antigravityDelegatedModel(provider, "gemini-4-neon-unknown")).toBeUndefined();
  expect(
    antigravityDelegatedModel(
      { ...provider, driver: "codex" } as ServerProvider,
      "gemini-4-neon-high",
    ),
  ).toBeUndefined();
});

it("explicit options override a suffix and empty options clear it", () => {
  const thinking = { id: "thought_level", value: "high" };
  expect(delegatedOptions(undefined, undefined, thinking)).toEqual([thinking]);
  expect(delegatedOptions(undefined, [{ id: "thought_level", value: "medium" }], thinking)).toEqual(
    [{ id: "thought_level", value: "medium" }],
  );
  expect(delegatedOptions(undefined, [], thinking)).toEqual([]);
});
