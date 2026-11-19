import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
} from "./composerPromptHistory";

it("recalls a referenced thread together with its backing record", () => {
  const thread = threadContextRecord(
    { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("other") },
    "Other",
  );
  const text = `Review ${formatInlineContextReference(threadContextReference(thread))}`;
  const entries = buildComposerPromptHistoryEntries([
    { id: "one", role: "user", text, context: { version: 1, records: [thread] } },
  ]);
  const step = stepComposerPromptHistory({
    direction: "backward",
    entries,
    position: null,
    currentPrompt: "",
  });
  expect(step?.prompt).toBe(text);
  expect(step?.threadContexts).toEqual([thread]);
});
