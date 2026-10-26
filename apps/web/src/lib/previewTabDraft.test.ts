import { EnvironmentId, OrchestrationMessageContext } from "@goat/contracts";
import { screenBindingHintsFromOrigin } from "@goat/shared/turnCapabilities";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildMessageContext } from "./composerContextRecords";
import { formatInlineContextReference } from "./composerContextReferences";
import { previewTabRecordForServerTab } from "./previewTabDraft";

describe("server browser tab mentions", () => {
  it("a picked tab reaches the server as an exact tab hint even with a messy title", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const record = previewTabRecordForServerTab(environmentId, {
      tabId: "tab-7",
      title: "  Orders [beta]\n  dashboard ",
      url: "https://example.test/orders",
    });
    const text = `check ${formatInlineContextReference(record)} please`;
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      previewTabs: [record],
      text,
    });
    const sent = Schema.decodeUnknownSync(OrchestrationMessageContext)(context);
    const hints = screenBindingHintsFromOrigin({ text, records: sent.records });
    expect(hints.tabs).toEqual([
      expect.objectContaining({
        mentionId: record.contextId,
        environmentId,
        browserInstanceId: record.browserInstanceId,
        tabId: "tab-7",
      }),
    ]);
  });
});
