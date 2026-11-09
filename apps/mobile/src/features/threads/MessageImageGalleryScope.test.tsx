import { BearerConnectionTarget, SshConnectionTarget } from "@goat/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// A prepared connection that changes like the real atom: subscribers re-render on reconnect.
const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    value: undefined as unknown,
    set(next: unknown) {
      this.value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePreparedConnection: () =>
      useSyncExternalStore(
        (listener) => connection.subscribe(listener),
        () => connection.value,
      ),
  };
});
vi.mock("../../lib/composerImageGallery", () => ({ composerImageGallery: () => [] }));
vi.mock("../../components/FilePreviewGallery", () => ({
  FilePreviewGallery: (props: { value: ReadonlyArray<{ uri?: string }>; children: ReactNode }) => (
    <ol>
      {props.value.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a fixed test list
        <li key={index}>{item.uri}</li>
      ))}
    </ol>
  ),
}));

import { MessageImageGalleryScope } from "./MessageImageGalleryScope";
import type { ThreadFeedRow } from "./pending-thread-feed";

it("pages to a remote environment's localhost image only while this device can reach it", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environmentId = EnvironmentId.make("remote");
  const remote = { environmentId, label: "Build box" };
  const tailnet = Option.some({
    httpBaseUrl: "http://100.65.180.100:3773",
    target: new BearerConnectionTarget({ ...remote, connectionId: "saved:box" }),
  });
  const ssh = Option.some({
    httpBaseUrl: "http://127.0.0.1:41234",
    target: new SshConnectionTarget({ ...remote, connectionId: "ssh:box" }),
  });
  const entry = {
    type: "message",
    message: { text: "![a](https://cdn.test/a.png) ![b](http://localhost:5173/b.png)" },
  } as unknown as ThreadFeedRow;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const gallery = () => [...container.querySelectorAll("li")].map((item) => item.textContent);
  connection.value = ssh;
  act(() =>
    root.render(
      <MessageImageGalleryScope
        entry={entry}
        environmentId={environmentId}
        threadId={ThreadId.make("thread")}
        workspaceRoot="/repo"
      >
        {null}
      </MessageImageGalleryScope>,
    ),
  );
  expect(gallery()).toEqual(["https://cdn.test/a.png"]);
  act(() => connection.set(tailnet));
  expect(gallery()).toEqual(["https://cdn.test/a.png", "http://100.65.180.100:5173/b.png"]);
  act(() => connection.set(ssh));
  expect(gallery()).toEqual(["https://cdn.test/a.png"]);
});
