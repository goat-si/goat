import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

describe("voice composer presentation", () => {
  it("names the device that transcribes while recording and transcribing", () => {
    const base = { error: null, errorAction: null } as const;
    expect(
      resolveVoiceComposerPresentation(
        { ...base, phase: "recording", location: { kind: "this-device" } },
        65,
      ).statusLabel,
    ).toBe("Recording 1:05 · on this device");
    expect(
      resolveVoiceComposerPresentation(
        {
          ...base,
          phase: "transcribing",
          location: {
            kind: "environment",
            environmentId: EnvironmentId.make("studio"),
            label: "Mac Studio",
          },
        },
        0,
      ).statusLabel,
    ).toBe("Transcribing · on Mac Studio");
  });
});
