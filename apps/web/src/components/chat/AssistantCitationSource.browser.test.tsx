import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { AssistantCitationSource } from "./AssistantCitationSource";

it.each([false, true])(
  "focuses the cited answer unless an editor is active: %s",
  async (editing) => {
    const container = document.createElement("div");
    container.style.cssText = "height:400px;overflow:auto";
    const input = document.createElement("input");
    document.body.append(input);
    using _input = { [Symbol.dispose]: () => input.remove() };
    if (editing) input.focus();
    const list = {
      getScrollableNode: () => container,
      getState: () => ({
        indexByKey: () => 0,
        sizeAtIndex: () => 20,
        scroll: 0,
        listenToPosition: () => () => {},
        listen: () => () => {},
      }),
      scrollToOffset: async () => {},
    } as unknown as LegendListRef;
    const onComplete = vi.fn();
    const request = {
      key: "citation",
      citation: {
        version: 1 as const,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        text: "cited answer",
        start: 0,
        end: 12,
        prefix: "",
        suffix: "",
      },
      activationRef: { current: { scrolled: false, dismissed: false } },
      onComplete,
    };
    await using screen = await render(
      <AssistantCitationSource
        messageId={request.citation.messageId}
        itemKey="item"
        listRef={{ current: list }}
        request={request}
      >
        <p>cited answer</p>
      </AssistantCitationSource>,
      { container },
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    const source = screen.container.querySelector("[data-assistant-citation-source]");
    expect(
      editing ? document.activeElement === input : source?.contains(document.activeElement),
    ).toBe(true);
  },
);
