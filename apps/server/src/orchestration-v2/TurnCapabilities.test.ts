import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ComposerContextId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@goat/contracts";
import { withTurnCapabilities } from "@goat/shared/turnCapabilities";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";

import { preparedTurnCapabilities, runTurnCapabilities } from "./TurnCapabilities.ts";
import { runPrepareInput } from "./RunExecutionService.ts";

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

it("a restart continuation carries only its referenced exact tab hint", () => {
  const source = run(1);
  const tab = {
    version: 1 as const,
    kind: "preview-tab" as const,
    contextId: ComposerContextId.make("tab-one"),
    label: "Docs",
    environmentId: EnvironmentId.make("environment-1"),
    browserInstanceId: "browser-one",
    tabId: "tab-one",
    title: "Docs",
    url: "https://example.test/docs",
  };
  const sourceMessage = message(source, {
    text: formatComposerContextReference(tab),
    context: { version: 1, records: [tab] },
  });
  const restart = run(2, { restartContinuationOfRunId: source.id });
  const restartMessage = message(restart, { creationSource: "server", text: "Continue" });
  const projection = { runs: [source, restart], messages: [sourceMessage, restartMessage] };
  assert.deepEqual(
    runPrepareInput({ run: restart, message: restartMessage, projection }).screenBindingHints?.tabs,
    [
      {
        mentionId: tab.contextId,
        environmentId: tab.environmentId,
        browserInstanceId: tab.browserInstanceId,
        tabId: tab.tabId,
        titleAtMention: tab.title,
        urlAtMention: tab.url,
      },
    ],
  );
  assert.deepEqual(
    runPrepareInput({ run: source, message: { ...sourceMessage, text: "No tab" }, projection })
      .screenBindingHints?.tabs,
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
  assert.deepEqual(
    preparedTurnCapabilities(true, { turnCapabilities: [] }, { turnCapabilities: ["browser"] }),
    { turnCapabilities: [] },
  );
  // Turn B asked for the browser; a rotation that read turn A's input must not remove it.
  assert.deepEqual(
    preparedTurnCapabilities(true, { turnCapabilities: ["browser"] }, { turnCapabilities: [] }),
    {
      turnCapabilities: ["browser"],
    },
  );
  // Opening a turn always carries that turn's own chips.
  assert.deepEqual(
    preparedTurnCapabilities(false, { turnCapabilities: ["browser"] }, { turnCapabilities: [] }),
    { turnCapabilities: [] },
  );
  assert.deepEqual(
    preparedTurnCapabilities(
      false,
      { turnCapabilities: undefined },
      { turnCapabilities: ["browser"] },
    ),
    {
      turnCapabilities: ["browser"],
    },
  );
});
