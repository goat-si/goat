import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@goat/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";

import { OPENCODE_BACKGROUND_WAKE_PROMPT } from "./input.ts";

const runTexts = (projection: OrchestrationV2ThreadProjection, runId: string | undefined) =>
  projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );

export function assertOpenCodeBackgroundWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE_BACKGROUND_WAKE_PROMPT]);
  const [rootRun, wakeRun] = projection.runs;
  assert.isDefined(rootRun);
  assert.isDefined(wakeRun);

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.isDefined(subagent);
  assert.deepInclude(subagent, {
    origin: "provider_native",
    status: "completed",
    runId: rootRun.id,
  });
  assert.isNotNull(subagent.childThreadId);
  const child = result.projections.get(subagent.childThreadId);
  assert.isTrue(
    child?.turnItems.some((item) => item.type === "assistant_message" && item.text === "CHILD_OK"),
    "the child's answer stays on the child thread",
  );

  const wakeMessage = projection.messages.find((message) => message.id === wakeRun.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.deepEqual(runTexts(projection, rootRun.id), ["PARENT_OK"]);
  assert.deepEqual(
    runTexts(projection, wakeRun.id),
    ["The background task returned CHILD_OK."],
    "OpenCode's own turn lands on the run that admitted it",
  );
}
