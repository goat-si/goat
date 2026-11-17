import {
  type OrchestrationV2ProjectedTurnItem,
  type ResponseContextRecord,
  ThreadId,
} from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { Atom } from "effect/reactivity";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import type { ComposerHandleRef } from "../../composerHandleContext";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { environmentThreadShells } from "../../state/threads";
import type { ChatComposerHandle } from "./chatComposerHandle";
import { useComposerReplyTarget } from "./composerReplyTarget";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  baseProps,
  click,
  ENVIRONMENT_ID,
  type Entry,
  message,
  renderElement,
} from "./MessagesTimeline.browserHarness";

const PARENT = ThreadId.make("parent");

// A side chat or run fork shows its source's history as inherited rows.
const inheritedResponse: Entry = {
  ...message("The empty state now renders a hint.", { role: "assistant" }, "m1"),
  projectedItem: {
    position: 0,
    visibility: "inherited",
    sourceThreadId: PARENT,
    sourceItemId: "item-1",
    item: {
      id: "item-1",
      threadId: PARENT,
      runId: "run-1",
      nodeId: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      type: "assistant_message",
      messageId: "m1",
    },
  } as unknown as OrchestrationV2ProjectedTurnItem,
} as Entry;

function serverConfigs(replyToResponse: boolean, parentShell: unknown = undefined) {
  const configs = new Map([
    [ENVIRONMENT_ID, { environment: { capabilities: { replyToResponse } } }],
  ]);
  const parentShellAtom = environmentThreadShells.threadShellAtom(
    scopeThreadRef(ENVIRONMENT_ID, PARENT),
  );
  const get = appAtomRegistry.get.bind(appAtomRegistry);
  return vi
    .spyOn(appAtomRegistry, "get")
    .mockImplementation(((atom: Atom.Atom<unknown>) =>
      atom === environmentPresentations.serverConfigsAtom
        ? configs
        : parentShell !== undefined && atom === parentShellAtom
          ? parentShell
          : get(atom)) as typeof appAtomRegistry.get);
}

function SideChatColumn({ handleRef }: { handleRef: ComposerHandleRef }) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <AppAtomRegistryProvider>
      <div data-chat-column style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <MessagesTimeline
          {...baseProps()}
          routeThreadKey="environment-local:side-chat"
          timelineEntries={[inheritedResponse]}
        />
        <form data-chat-composer-form="true" ref={useComposerReplyTarget(formRef, handleRef)} />
      </div>
    </AppAtomRegistryProvider>
  );
}

function composer() {
  const replyToResponse = vi.fn((_response: ResponseContextRecord) => true);
  const ref: ComposerHandleRef = { current: { replyToResponse } as unknown as ChatComposerHandle };
  return { ref, replyToResponse };
}

it("names the thread that holds the response when Reply is on a row a side chat inherits", async () => {
  using _configs = serverConfigs(true);
  const target = composer();
  await using screen = await renderElement(<SideChatColumn handleRef={target.ref} />);

  await click(screen.button("Reply to this response"));

  expect(target.replyToResponse).toHaveBeenCalledTimes(1);
  const [record] = target.replyToResponse.mock.calls[0]!;
  expect(record.citation).toMatchObject({ environmentId: ENVIRONMENT_ID, threadId: PARENT });
  expect(record.itemId).toBe("item-1");
});

it("offers no Reply when the thread's server does not check replies", async () => {
  using _configs = serverConfigs(false);
  const target = composer();
  await using screen = await renderElement(<SideChatColumn handleRef={target.ref} />);

  await expect.element(screen.getByText("The empty state now renders a hint.")).toBeVisible();
  expect(screen.buttons("Reply to this response")).toHaveLength(0);
});

it("offers no Reply on a row inherited from a deleted thread, which no agent can read", async () => {
  using _configs = serverConfigs(true, { id: PARENT, deletedAt: "2026-11-17T00:00:00Z" });
  const target = composer();
  await using screen = await renderElement(<SideChatColumn handleRef={target.ref} />);

  await expect.element(screen.getByText("The empty state now renders a hint.")).toBeVisible();
  expect(screen.buttons("Reply to this response")).toHaveLength(0);
});
