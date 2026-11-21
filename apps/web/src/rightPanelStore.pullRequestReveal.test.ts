import { scopeThreadRef } from "@goat/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@goat/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";
import { reopenClosedView } from "./reopenClosedView";
import {
  pullRequestSurfaceId,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

async function reloadRightPanelStore() {
  const { storage, name } = useRightPanelStore.persist.getOptions();
  const persisted = storage && name ? await storage.getItem(name) : null;
  expect(persisted).not.toBeNull();
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  if (storage && name && persisted) await storage.setItem(name, persisted);
  await useRightPanelStore.persist.rehydrate();
}

it("holds a clicked link until the panel settles it, and never persists or reopens it", async () => {
  const pr = { projectId: "project-a", repository: "goat-si/goat", number: 4909 };
  const id = pullRequestSurfaceId(pr);
  const url = "https://github.com/goat-si/goat/pull/4909";
  const surface = () =>
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA);
  const comment = (n: number) => `${url}#issuecomment-${n}`;
  const store = useRightPanelStore.getState();
  store.openPullRequest(refA, { ...pr, url: comment(1), revealUrl: comment(1) });
  expect(surface()).toMatchObject({ url: comment(1), revealUrl: comment(1) });
  store.openPullRequest(refA, { ...pr, url });
  expect(surface()).not.toHaveProperty("revealUrl");
  store.openPullRequest(refA, { ...pr, url: comment(2), revealUrl: comment(2) });
  // A host read started for an earlier link settles only that link.
  store.settlePullRequestReveal(refA, id, comment(1));
  expect(surface()).toMatchObject({ revealUrl: comment(2) });
  store.settlePullRequestReveal(refA, id, comment(2));
  expect(surface()).toMatchObject({ url: comment(2) });
  expect(surface()).not.toHaveProperty("revealUrl");
  // A reload hands back the tab without the link it was opened by.
  store.openPullRequest(refA, { ...pr, url: comment(3), revealUrl: comment(3) });
  await reloadRightPanelStore();
  expect(surface()).toMatchObject({ url: comment(3) });
  expect(surface()).not.toHaveProperty("revealUrl");
  // So does reopening a closed tab.
  store.openPullRequest(refA, { ...pr, url: comment(4), revealUrl: comment(4) });
  store.closeSurface(refA, id);
  const [closed] = useClosedViewStore.getState().entries;
  expect(closed).toBeDefined();
  if (closed) {
    await reopenClosedView(closed, {
      workspaceAvailable: true,
      openPreview: () => {
        throw new Error("A PR tab must not create a browser session");
      },
    });
  }
  expect(surface()).toMatchObject({ url: comment(4) });
  expect(surface()).not.toHaveProperty("revealUrl");
});
