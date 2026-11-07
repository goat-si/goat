import type { OrchestrationV2Run, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

const noticesByWorld = new WeakMap<object, Map<string, RunId>>();

/** One harness's background command notices: notice run id → the run whose command it reports. */
export const noticeRunsOf = (world: object) => {
  const known = noticesByWorld.get(world);
  if (known !== undefined) return known;
  const notices = new Map<string, RunId>();
  noticesByWorld.set(world, notices);
  return notices;
};

/** A worker thread's messages: the notice GOAT sent to start a run, and each run's final answer. */
export const harnessMessages = (
  world: { readonly finalText: ReadonlyMap<string, string> },
  runs: ReadonlyArray<OrchestrationV2Run>,
  messageRunIds: ReadonlyArray<string> | undefined,
) =>
  runs
    .filter((run) => messageRunIds === undefined || messageRunIds.includes(run.id))
    .flatMap((run) => {
      const createdAt = DateTime.makeUnsafe("2026-10-12T00:05:00.000Z");
      const about = noticeRunsOf(world).get(run.id);
      const text = world.finalText.get(run.id);
      return [
        ...(about === undefined
          ? []
          : [
              {
                id: run.userMessageId,
                role: "user",
                text: "",
                streaming: false,
                runId: run.id,
                notification: {
                  source: { kind: "command" },
                  outcome: "completed",
                  summary: "Command ended",
                  aboutRunId: about,
                },
                createdAt,
              },
            ]),
        ...(text === undefined
          ? []
          : [{ role: "assistant", text, streaming: false, runId: run.id, createdAt }]),
      ];
    });
