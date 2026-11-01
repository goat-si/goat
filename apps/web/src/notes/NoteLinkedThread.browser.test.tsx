import { EnvironmentId, ThreadId, type NoteThreadLink } from "@goat/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { NoteLinkedThread } from "./NoteLinkedThread";

vi.mock("../state/entities", () => ({ useQuietThreadShell: () => undefined }));
const thread: NoteThreadLink = {
  host: "remote",
  threadId: ThreadId.make("thread-1"),
  lastResult: null,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows an unconnected host as plain text with a Connections hint and no dead link", async () => {
  await act(async () =>
    root.render(
      <ul>
        <NoteLinkedThread thread={thread} destination={undefined} />
      </ul>,
    ),
  );
  expect(container.textContent).toContain("Thread · remote");
  expect(container.textContent).toContain("Connect remote in Settings → Connections to open it");
  expect(container.querySelector("a")).toBeNull();
});
it("opens a connected remote thread through the application router", async () => {
  const destination = EnvironmentId.make("remote-environment");
  const base = createRootRoute();
  const notes = createRoute({
    getParentRoute: () => base,
    path: "/notes",
    component: () => (
      <ul>
        <NoteLinkedThread thread={thread} destination={destination} />
      </ul>
    ),
  });
  const target = createRoute({
    getParentRoute: () => base,
    path: "/$environmentId/$threadId",
    component: () => <p>Opened remote work</p>,
  });
  const router = createRouter({
    routeTree: base.addChildren([notes, target]),
    history: createMemoryHistory({ initialEntries: ["/notes"] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  const link = container.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("/remote-environment/thread-1");
  await act(async () => {
    link.click();
    await router.load();
  });
  expect(router.state.location.pathname).toBe("/remote-environment/thread-1");
  expect(container.textContent).toContain("Opened remote work");
});
