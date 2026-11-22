import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import type { ChildThreadApproval } from "@goat/client-runtime/state/thread-requests";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: (props: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));

import { ChildApprovalContext } from "./ChildApprovalContext";

const environmentId = EnvironmentId.make("worker-machine");
function approval(worker: string, request: string): ChildThreadApproval {
  return {
    thread: { environmentId, threadId: ThreadId.make(worker) },
    title: worker,
    approval: {
      requestId: RuntimeRequestId.make(request),
      requestKind: "file-change",
      responseCapability: "live",
      createdAt: "2026-11-21T10:00:00.000Z",
    },
  };
}

it("counts waiting workers once and opens the selected worker's scoped thread", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const opened: ChildThreadApproval["thread"][] = [];
  using _cleanup = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () =>
    root.render(
      <ChildApprovalContext
        approvals={[
          approval("Scout", "one"),
          approval("Scout", "two"),
          approval("Builder", "three"),
        ]}
        onOpenWorker={(thread) => opened.push(thread)}
      />,
    ),
  );
  expect(container.textContent).toContain("2 waiting");
  expect(container.querySelectorAll("button")).toHaveLength(2);
  container.querySelector<HTMLButtonElement>('button[aria-label="Open worker · Builder"]')?.click();
  expect(opened).toEqual([{ environmentId, threadId: "Builder" }]);
});
