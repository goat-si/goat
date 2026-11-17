import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DecisionUserInputForm } from "./DecisionUserInputForm";

const item: Extract<DecisionItem, { kind: "user_input" }> = {
  id: "side-question",
  ref: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
  routing: { routedTo: "person" },
  kind: "user_input",
  createdAt: "2026-10-01T00:00:00.000Z",
  request: {
    requestId: RuntimeRequestId.make("side-question"),
    createdAt: "2026-10-01T00:00:00.000Z",
    responseCapability: "live",
    dismissible: false,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "How should this be fixed?",
        multiSelect: false,
        options: [],
      },
    ],
  },
};

function Form(props: {
  readonly onSubmit: (answers: Record<string, string | string[]>) => Promise<unknown>;
  readonly onSideChat: (prompt: string) => void;
}) {
  const [drafts, setDrafts] = useState({});
  return (
    <DecisionUserInputForm
      item={item}
      drafts={drafts}
      disabled={false}
      sideChatAvailable
      onChange={setDrafts}
      onSubmit={props.onSubmit}
      onSideChat={props.onSideChat}
    />
  );
}

it('"/side ..." typed in the inbox opens the side chat and is not sent as an answer', async () => {
  const onSubmit = vi.fn(async () => undefined);
  const onSideChat = vi.fn();
  // The form renders no links; the inbox around it navigates.
  await using screen = await render(<Form onSubmit={onSubmit} onSideChat={onSideChat} />, {
    router: false,
  });
  await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "/side what changed?");
  await userEvent.click(screen.getByRole("button", { name: "Submit answer" }));

  expect(onSideChat).toHaveBeenCalledExactlyOnceWith("what changed?");
  expect(onSubmit).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("");
});
