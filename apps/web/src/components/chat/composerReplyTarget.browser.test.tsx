import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  type ResponseContextRecord,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { ChatComposerHandle } from "./chatComposerHandle";
import { replyFromTimeline, useComposerReplyTarget } from "./composerReplyTarget";

const reply: ResponseContextRecord = {
  version: 1,
  kind: "response",
  contextId: "response_m1" as ComposerContextId,
  label: "The fix is in",
  citation: {
    version: 1,
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make("same-thread"),
    messageId: MessageId.make("m1"),
    text: "The fix is in",
    start: 0,
    end: 13,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make("item-1"),
};

function handle(accepts = true) {
  const replyToResponse = vi.fn((_response: ResponseContextRecord) => accepts);
  const ref: ComposerHandleRef = { current: { replyToResponse } as unknown as ChatComposerHandle };
  return { ref, replyToResponse };
}

function Composer({ handleRef }: { handleRef: ComposerHandleRef }) {
  const formRef = useRef<HTMLFormElement>(null);
  return <form data-chat-composer-form="true" ref={useComposerReplyTarget(formRef, handleRef)} />;
}

// Two chat columns showing the same thread, each with its own composer.
function Columns(props: { left: ComposerHandleRef; right: ComposerHandleRef | null }) {
  return (
    <>
      <div data-chat-column>
        <button type="button">Reply left</button>
        <Composer handleRef={props.left} />
      </div>
      <div data-chat-column>
        <button type="button">Reply right</button>
        {props.right ? <Composer handleRef={props.right} /> : null}
      </div>
    </>
  );
}

describe("Reply finds the composer beside the message", () => {
  it("replies in the clicked column's composer when the same thread is open twice", async () => {
    const left = handle();
    const right = handle();
    await using screen = await render(<Columns left={left.ref} right={right.ref} />);
    const button = screen.container.querySelectorAll("button")[1];
    expect(replyFromTimeline(button!, reply)).toBe("replying");
    expect(right.replyToResponse).toHaveBeenCalledWith(reply);
    expect(left.replyToResponse).not.toHaveBeenCalled();
  });

  it("reports a composer that refuses the reply", async () => {
    const left = handle(false);
    await using screen = await render(<Columns left={left.ref} right={null} />);
    const button = screen.container.querySelector("button");
    expect(replyFromTimeline(button!, reply)).toBe("refused");
  });

  it("leaves nothing behind when a composer unmounts", async () => {
    const left = handle();
    const right = handle();
    await using screen = await render(<Columns left={left.ref} right={right.ref} />);
    await screen.rerender(<Columns left={left.ref} right={null} />);
    const button = screen.container.querySelectorAll("button")[1];
    expect(replyFromTimeline(button!, reply)).toBe("no-composer");
    expect(right.replyToResponse).not.toHaveBeenCalled();
  });
});
