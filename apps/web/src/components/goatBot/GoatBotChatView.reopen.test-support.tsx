import type React from "react";
import {
  ThreadId,
  type ScopedThreadRef,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadStreamItem,
} from "@goat/contracts";
import type { createEnvironmentThreadDetailAtoms } from "@goat/client-runtime/state/threads";
import type * as Queue from "effect/Queue";
import { expect } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { turnItem } from "./GoatBotChatView.sync.fixtures";
type ThreadDetails = ReturnType<typeof createEnvironmentThreadDetailAtoms>;
type Socket = Queue.Queue<OrchestrationV2ThreadStreamItem>;
type ReopenDriver = {
  readonly MemberChat: React.ComponentType<{ readonly threadRef: ScopedThreadRef }>;
  readonly setup: (
    thread: string,
    history: ReadonlyArray<OrchestrationV2TurnItem>,
  ) => ScopedThreadRef;
  readonly synchronized: (
    ref: ScopedThreadRef,
  ) => Promise<{ socket: Socket; details: ThreadDetails }>;
  readonly deliver: (
    socket: Socket,
    details: ThreadDetails,
    ref: ScopedThreadRef,
    item: OrchestrationV2TurnItem,
    sequence: number,
  ) => Promise<void>;
};
function SidebarSubscription({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const items = useThreadVisibleTurnItems(threadRef);
  return <output data-testid="sidebar-items">{items.length}</output>;
}

function ReopenChat({
  threadRef,
  open,
  MemberChat,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly open: boolean;
  readonly MemberChat: React.ComponentType<{ readonly threadRef: ScopedThreadRef }>;
}) {
  return (
    <AppAtomRegistryProvider>
      <SidebarSubscription threadRef={threadRef} />
      {open ? <MemberChat threadRef={threadRef} /> : null}
    </AppAtomRegistryProvider>
  );
}

export async function verifySidebarReopen({
  setup,
  synchronized,
  deliver,
  MemberChat,
}: ReopenDriver) {
  const id = ThreadId.make("sidebar-reopen");
  const threadRef = setup(id, [
    turnItem(id, "history-reply", "assistant", "History reply", 1),
    turnItem(
      id,
      "history-user",
      "user",
      Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n"),
      2,
    ),
  ]);
  await using screen = await render(
    <ReopenChat MemberChat={MemberChat} threadRef={threadRef} open={false} />,
  );
  const { socket, details } = await synchronized(threadRef);
  await screen.rerender(<ReopenChat MemberChat={MemberChat} threadRef={threadRef} open />);
  expect(screen.container.textContent).toContain("History reply");
  await screen.rerender(<ReopenChat MemberChat={MemberChat} threadRef={threadRef} open={false} />);
  await deliver(
    socket,
    details,
    threadRef,
    turnItem(threadRef.threadId, "while-closed", "assistant", "While closed", 3),
    2,
  );
  expect(screen.getByTestId("sidebar-items").element().textContent).toBe("3");
  expect(appAtomRegistry.get(details.statusAtom(threadRef))).toBe("live");
  await screen.rerender(<ReopenChat MemberChat={MemberChat} threadRef={threadRef} open />);
  expect(appAtomRegistry.get(details.statusAtom(threadRef))).toBe("live");
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  if (!status) throw new Error("missing bot status");
  expect(status.textContent).toBe("");
  expect(screen.container.textContent).toContain("History reply");
  expect(screen.container.textContent).toContain("While closed");
  expect(screen.container.textContent).not.toContain("Jump to latest");
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div");
  if (!scroll) throw new Error("missing transcript scroller");
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  expect(screen.container.textContent).not.toContain("Jump to latest");
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => changes.push(...batch));
  observer.observe(status, { subtree: true, childList: true, characterData: true });
  try {
    await deliver(
      socket,
      details,
      threadRef,
      turnItem(threadRef.threadId, "catch-up", "assistant", "Catch-up reply", 4),
      3,
    );
    expect(status.textContent?.match(/Research replied\.|New reply from Research\./g)).toHaveLength(
      1,
    );
    expect(changes).toHaveLength(1);
    await expect
      .element(screen.getByRole("button", { name: "Jump to latest", exact: true }))
      .toBeVisible();
    const catchUpClause = status.textContent;
    await act(() => {
      scroll.scrollTop = scroll.scrollHeight;
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(screen.container.textContent).not.toContain("Jump to latest");
    await act(() => {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    });
    await deliver(
      socket,
      details,
      threadRef,
      turnItem(threadRef.threadId, "new-reply", "assistant", "New reply", 5),
      4,
    );
    expect(status.textContent?.match(/Research replied\.|New reply from Research\./g)).toHaveLength(
      1,
    );
    expect(status.textContent).not.toBe(catchUpClause);
    expect(changes).toHaveLength(2);
    await expect
      .element(screen.getByRole("button", { name: "Jump to latest", exact: true }))
      .toBeVisible();
    await screen.rerender(<ReopenChat MemberChat={MemberChat} threadRef={threadRef} open />);
    expect(changes).toHaveLength(2);
  } finally {
    observer.disconnect();
  }
}
