import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@goat/contracts";
import { withTurnCapabilities } from "@goat/shared/turnCapabilities";
import * as DateTime from "effect/DateTime";

import { preparedTurnCapabilities, runTurnCapabilities } from "./TurnCapabilities.ts";

const now = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");
const run = (index: number, fields: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(`capability-run:${index}`),
  threadId: ThreadId.make("capability-thread"),
  ordinal: index,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  providerThreadId: null,
  userMessageId: MessageId.make(`capability-message:${index}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "starting",
  requestedAt: now,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});
const message = (
  owner: OrchestrationV2Run,
  fields: Partial<OrchestrationV2ConversationMessage>,
): OrchestrationV2ConversationMessage => ({
  id: owner.userMessageId,
  threadId: owner.threadId,
  runId: owner.id,
  nodeId: null,
  role: "user",
  text: "",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  ...fields,
});

it("a restart continuation keeps the @browser chip of the message it continues", () => {
  const source = run(1);
  const sourceMessage = message(source, withTurnCapabilities({ text: "Check it" }, ["browser"]));
  const restart = run(2, { restartContinuationOfRunId: source.id });
  const restartMessage = message(restart, { creationSource: "server", text: "Continue" });
  const projection = { runs: [source, restart], messages: [sourceMessage, restartMessage] };
  assert.deepEqual(runTurnCapabilities({ run: restart, message: restartMessage, projection }), [
    "browser",
  ]);
  assert.deepEqual(
    runTurnCapabilities({
      run: restart,
      message: restartMessage,
      projection: { ...projection, runs: [restart] },
    }),
    [],
  );
});

it("a message whose chip was deleted asks for nothing", () => {
  const owner = run(1);
  const asked = withTurnCapabilities({ text: "Check it" }, ["computer-use"]);
  const edited = message(owner, { ...asked, text: "Check it" });
  assert.deepEqual(
    runTurnCapabilities({
      run: owner,
      message: edited,
      projection: { runs: [owner], messages: [edited] },
    }),
    [],
  );
});

it("an internal re-prepare keeps the current turn's chips, whichever way its stale copy differs", () => {
  // Turn A asked for the browser; turn B, admitted under the lock since, did not.
  assert.deepEqual(preparedTurnCapabilities("internal", [], ["browser"]), { turnCapabilities: [] });
  // Turn B asked for the browser; a rotation that read turn A's input must not remove it.
  assert.deepEqual(preparedTurnCapabilities("internal", ["browser"], []), {
    turnCapabilities: ["browser"],
  });
  // Opening a turn always carries that turn's own chips.
  assert.deepEqual(preparedTurnCapabilities("open", ["browser"], []), { turnCapabilities: [] });
  assert.deepEqual(preparedTurnCapabilities("open", undefined, ["browser"]), {
    turnCapabilities: ["browser"],
  });
});
