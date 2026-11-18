import { it as effectIt } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect.each([
  "native",
  "unsupported",
  "unaccepted",
  "registered-unsent",
  "ambiguous",
  "legacy",
  "restart-stub",
] as const)("handles manual Resume with a %s source", (scenario) =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue where you left off.",
      manualResume: {
        accepted: scenario !== "unaccepted",
        supported: scenario !== "unsupported" && scenario !== "unaccepted",
        ...(scenario === "registered-unsent" ? { delivery: "unsent" } : {}),
        ...(scenario === "ambiguous" ? { delivery: "ambiguous" } : {}),
        ...(scenario === "legacy" ? { legacy: true } : {}),
        ...(scenario === "restart-stub" ? { restart: true, delivery: "unsent" } : {}),
      },
      previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
    });
    yield* harness.start;
    if (scenario === "ambiguous" || scenario === "legacy" || scenario === "restart-stub") {
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          failure: {
            message:
              "GOAT could not confirm whether the provider received the previous message. Send a message to continue.",
          },
        },
      ]);
      expect(harness.startRootRun).not.toHaveBeenCalled();
    } else if (scenario === "unsupported") {
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          failure: {
            message:
              "This provider cannot resume without a new message. Send a message to continue.",
          },
        },
      ]);
      expect(harness.startRootRun).not.toHaveBeenCalled();
    } else {
      expect(harness.projection().turnItems).toEqual([]);
      const started = harness.startRootRun.mock.calls.at(-1)?.[0];
      expect(started?.resume).toBe(scenario === "native");
      expect(started?.message.text).toBe(scenario === "native" ? "" : "Original prompt");
    }
  }),
);

effectIt.effect("manual Resume replays an unaccepted steering replacement and its image", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue where you left off.",
      manualResume: { accepted: true, supported: true, replacement: true },
      previousTurn: { runStatus: "interrupted", turnStatus: "interrupted", supersededTurn: true },
    });
    yield* harness.start;
    const started = harness.startRootRun.mock.calls.at(-1)?.[0];
    expect(started?.resume).toBe(false);
    expect(started?.message.text).toBe("Replacement prompt");
    expect(started?.message.attachments.map((image) => image.id)).toEqual(["replacement-image"]);
  }),
);

effectIt.effect("a refused native Resume fails without starting a fresh session or a prompt", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue where you left off.",
      manualResume: { accepted: true, supported: true },
      previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
      resumeFailure: new ProviderAdapter.ProviderAdapterProtocolError({
        driver: ProviderDriverKind.make("codex"),
        detail: "Native session could not be attached.",
      }),
    });
    yield* harness.start;
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);
