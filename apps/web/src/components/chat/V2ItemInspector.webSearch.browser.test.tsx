import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";

const previewAccess = vi.hoisted(() => ({ granted: false, openLink: vi.fn(async () => {}) }));

vi.mock(import("../../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => previewAccess.granted,
}));
vi.mock(import("../../browser/useOpenLink"), () => ({
  useOpenLink: () => previewAccess.openLink,
}));
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("../../state/v2ItemSupport", () => ({ useV2ItemSupport: () => ({}) }));
vi.mock("../ChatMarkdown", () => ({
  default: () => null,
  ChatMarkdownAssetImage: () => null,
}));

import { V2ItemInspector } from "./V2ItemInspector";

const timestamp = DateTime.makeUnsafe("2026-06-20T00:00:03.000Z");

it("opens web search result links inside GOAT when Open links in is set to app", async () => {
  previewAccess.granted = true;
  previewAccess.openLink.mockClear();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserLinkTarget: "app" });
  onTestFinished(() => {
    previewAccess.granted = false;
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  });

  const threadId = ThreadId.make("thread-search");
  const item: Extract<OrchestrationV2TurnItem, { type: "web_search" }> = {
    id: TurnItemId.make("web-search"),
    threadId,
    runId: RunId.make("run-search"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    type: "web_search",
    patterns: ["https://example.com/"],
    results: [{ url: "https://example.com/", title: "Example Domain" }],
  };

  await using screen = await render(
    <V2ItemInspector
      projectedItem={{
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }}
      environmentId={EnvironmentId.make("environment-search")}
      workspaceRoot="/workspace"
      onOpenThread={vi.fn()}
    />,
  );

  const link = [...screen.container.querySelectorAll("a")].find(
    (anchor) => anchor.textContent === "Example Domain",
  );
  expect(link).toBeDefined();
  // A _blank click the app leaves to the browser goes to Electron's popup handler, which
  // sends it to the system browser.
  let followedNatively = true;
  await act(async () => {
    followedNatively = link!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
  expect(followedNatively).toBe(false);
  expect(previewAccess.openLink).toHaveBeenCalledOnce();
});
