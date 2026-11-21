import { expect, it } from "vite-plus/test";
import { recommendSpeechModel } from "./speechRecommendation.ts";

const models = [
  { id: "slow", languages: ["en"], accuracy: { en: 2 }, benchmark: { cpu: 12, accelerated: 2 } },
  { id: "balanced", languages: ["en"], accuracy: { en: 4 }, benchmark: { cpu: 2, accelerated: 1 } },
];

it("chooses a language-capable model by accuracy and the selected hardware tier", () => {
  expect(recommendSpeechModel(models, "en", "cpu")).toBe("balanced");
  expect(recommendSpeechModel(models, "en", "accelerated")).toBe("slow");
  expect(recommendSpeechModel(models, "ko", "cpu")).toBeUndefined();
});

it("makes no recommendation for absent, incomplete, malformed or negative metrics", () => {
  for (const accuracy of [undefined, {}, { en: -1 }, { en: Number.NaN }, { en: "bad" }]) {
    expect(recommendSpeechModel([{ ...models[0]!, accuracy }], "en", "cpu")).toBeUndefined();
  }
  expect(
    recommendSpeechModel(
      [{ ...models[0]!, benchmark: { cpu: -1, accelerated: null } }],
      "en",
      "cpu",
    ),
  ).toBeUndefined();
  expect(recommendSpeechModel(models, "en", undefined)).toBeUndefined();
});
