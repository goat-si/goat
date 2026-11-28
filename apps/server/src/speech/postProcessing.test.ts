import type { SpeechConfiguration } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { finalizeLocalTranscript } from "./postProcessing.ts";

const config: SpeechConfiguration = {
  modelId: "handy-computer/parakeet-unified-en-0.6b-gguf",
  acceleration: "auto",
  postProcessingMode: "local",
  postProcessingInstructions: "",
  customWords: [{ term: "GOAT", aliases: ["goat", "go at"] }],
};

it("removes filler words without a provider", () => {
  expect(finalizeLocalTranscript("So, um, I think, uh, it works.", config, "en-US")).toBe(
    "So, I think, it works.",
  );
});

it("corrects custom words while preserving their casing", () => {
  expect(finalizeLocalTranscript("go at is a go at tool", config, "en-US")).toBe(
    "GOAT is a GOAT tool",
  );
});

it("leaves the transcript alone when cleanup is off", () => {
  expect(
    finalizeLocalTranscript("um, go at", { ...config, postProcessingMode: "off" }, "en-US"),
  ).toBe("um, go at");
});

it("does not join paragraphs when removing fillers", () => {
  expect(finalizeLocalTranscript("uh, first line\n\nuh, second line", config, "en")).toBe(
    "first line\n\nsecond line",
  );
});
