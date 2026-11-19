import { ComposerContextId } from "@goat/contracts";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { expect, it } from "vite-plus/test";
import { resolveThreadQueueRowControls } from "./threadQueueControlPresentation";

it("shows queued context references as their labels", () => {
  const file = formatComposerContextReference({
    kind: "file",
    contextId: ComposerContextId.make("report"),
    label: "report.pdf",
  });
  expect(
    resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      canReorder: false,
      index: 0,
      queuedCount: 1,
      text: `Check ${file}`,
    }).displayText,
  ).toBe("Check report.pdf");
});
