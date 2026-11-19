import { it as effectIt } from "@effect/vitest";
import {
  ContextHandoffId,
  RunId,
  ProviderDriverKind,
  MessageId,
  RunAttemptId,
  TurnItemId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { missedTurnImages, missedTurnInputRuns } from "./goat/MissedTurnInput.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect.each(["", "Continue where you left off."])(
  "a manual resume with a handoff prompts the agent to continue: %s",
  (text) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text,
        manualResume: { accepted: true, supported: true },
        previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
      });
      const projection = harness.projection();
      const run = projection.runs.find((candidate) => candidate.id === harness.runId)!;
      harness.setProjection({
        ...projection,
        contextHandoffs: [
          {
            id: ContextHandoffId.make("resume-handoff"),
            threadId: harness.threadId,
            targetRunId: run.id,
            fromProviderThreadIds: [],
            toProviderThreadId: run.providerThreadId!,
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "full_thread_summary",
            status: "ready",
            summaryMessageId: null,
            summaryText: "Earlier work",
            createdByProviderInstanceId: run.providerInstanceId,
            createdAt: projection.updatedAt,
            updatedAt: projection.updatedAt,
          },
        ],
      });
      yield* harness.start;
      const started = harness.startRootRun.mock.calls.at(-1)?.[0];
      expect(started?.resume).toBe(false);
      expect(started?.message.text).toBe("Continue where you left off.");
    }),
);

effectIt.effect.each([
  "native",
  "unsupported",
  "unaccepted",
  "registered-unsent",
  "ambiguous",
  "legacy",
  "restart-stub",
  "usage-limit-stub",
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
        ...(scenario === "restart-stub"
          ? { syntheticContinuation: "restart", delivery: "unsent" }
          : {}),
        ...(scenario === "usage-limit-stub"
          ? { syntheticContinuation: "usage-limit", delivery: "unsent" }
          : {}),
      },
      previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
    });
    yield* harness.start;
    if (
      scenario === "ambiguous" ||
      scenario === "legacy" ||
      scenario === "restart-stub" ||
      scenario === "usage-limit-stub"
    ) {
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
      manualResume: {
        accepted: true,
        supported: true,
        replacement: true,
        syntheticContinuation: "usage-limit",
      },
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

effectIt.effect.each(["accepted", "ambiguous", "unsent"] as const)(
  "uses the manual replay's %s delivery when recovering its original input",
  (inputDelivery) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue where you left off.",
        manualResume: { accepted: false, supported: false },
        previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
      });
      yield* harness.start;
      const replayed = harness.startRootRun.mock.calls.at(-1)![0];
      expect(replayed.message.text).toBe("Original prompt");
      const projection = harness.projection();
      const followUp = {
        ...replayed.run,
        id: RunId.make("follow-up"),
        ordinal: replayed.run.ordinal + 1,
      };
      const missed = missedTurnInputRuns(
        {
          ...projection,
          attempts: projection.attempts.map((attempt) =>
            attempt.id === replayed.attempt.id ? { ...replayed.attempt, inputDelivery } : attempt,
          ),
        },
        followUp,
      );
      expect(missed.map((run) => run.userMessageId)).toEqual(
        inputDelivery === "unsent" ? ["resume-source-message"] : [],
      );
    }),
);

effectIt.effect(
  "does not reattach an older missed image after a manual replay may have sent it",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue where you left off.",
        manualResume: { accepted: false, supported: false },
        previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
      });
      yield* harness.start;
      const replay = harness.startRootRun.mock.calls.at(-1)![0];
      const projection = harness.projection();
      const older = {
        ...projection.runs[0]!,
        id: RunId.make("older-unsent-run"),
        userMessageId: MessageId.make("older-unsent-message"),
        ordinal: 1,
        status: "failed" as const,
      };
      const image = {
        type: "image" as const,
        id: "older-unsent-image",
        name: "older.png",
        mimeType: "image/png",
        sizeBytes: 100,
      };
      const historyItem = {
        type: "user_message" as const,
        inputIntent: "turn_start" as const,
        id: TurnItemId.make("older-unsent-item"),
        messageId: older.userMessageId,
        runId: older.id,
        threadId: older.threadId,
        providerThreadId: older.providerThreadId,
        providerTurnId: null,
        nodeId: null,
        parentItemId: null,
        nativeItemRef: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: older.startedAt,
        completedAt: older.completedAt,
        updatedAt: older.requestedAt,
        text: "Earlier request",
        attachments: [image],
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      const followUp = {
        ...replay.run,
        ordinal: replay.run.ordinal + 2,
        id: RunId.make("follow-up"),
      };
      const prior = {
        ...projection,
        runs: [older, ...projection.runs.map((run) => ({ ...run, ordinal: run.ordinal + 1 }))],
        attempts: [
          {
            ...replay.attempt,
            id: RunAttemptId.make("older-attempt"),
            runId: older.id,
            inputDelivery: "unsent" as const,
          },
          ...projection.attempts.map((attempt) =>
            attempt.id === replay.attempt.id
              ? { ...attempt, inputDelivery: "ambiguous" as const }
              : attempt,
          ),
        ],
      };
      const missedRuns = missedTurnInputRuns(prior, followUp);
      expect(missedRuns.map((run) => run.id)).toEqual([older.id]);
      expect(
        missedTurnImages({
          projection: prior,
          history: [historyItem],
          missedRuns,
          run: followUp,
          attachments: [],
          goalDriver: false,
        }),
      ).toEqual([]);
    }),
);

effectIt.effect.each(["accepted", "ambiguous", "unsent", undefined] as const)(
  "recovers missed input on Send after two legacy Resumes with %s delivery on the second",
  (inputDelivery) =>
    Effect.sync(() => {
      const {
        runs: [original, firstResume],
        attempts: [originalAttempt, firstAttempt],
        messages,
      } = makeLocalCommandHarness({
        text: "Continue where you left off.",
        manualResume: { accepted: false, supported: false },
        previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
      }).projection();
      const secondResume = {
        ...firstResume!,
        id: RunId.make("second-legacy-resume"),
        activeAttemptId: RunAttemptId.make("second-legacy-resume-attempt"),
        userMessageId: MessageId.make("second-legacy-resume-message"),
        manualContinuationOfRunId: firstResume!.id,
        ordinal: 3,
        status: "interrupted" as const,
      };
      const { manualContinuationOfRunId: _manualSource, ...followUp } = secondResume;
      const send = {
        ...followUp,
        id: RunId.make("follow-up-send"),
        userMessageId: MessageId.make("follow-up-send-message"),
        ordinal: 4,
        status: "starting" as const,
      };
      const missed = missedTurnInputRuns(
        {
          runs: [original!, { ...firstResume!, status: "interrupted" }, secondResume],
          attempts: [
            originalAttempt!,
            { ...firstAttempt!, status: "interrupted", inputDelivery: "unsent" },
            {
              ...firstAttempt!,
              id: secondResume.activeAttemptId,
              runId: secondResume.id,
              status: "interrupted",
              ...(inputDelivery === undefined ? {} : { inputDelivery }),
            },
          ],
          messages,
        },
        send,
      );
      expect(missed.map((run) => run.userMessageId)).toEqual(
        inputDelivery === "unsent" ? [original!.userMessageId] : [],
      );
    }),
);
