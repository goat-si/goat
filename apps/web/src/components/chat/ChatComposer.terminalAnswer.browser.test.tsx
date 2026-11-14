import { id, setupSshComposer, state, store } from "~/test/sshComposerFixture";
import { ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "~/test-fixtures";
import { act } from "../../../test/render";

vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
const renderComposer = ChatComposer.type;

it("does not add terminal output to the hidden draft while answering a question", async () => {
  await using fixture = await setupSshComposer(true);
  const thread = makeThreadFixture({ id: ThreadId.make("question-thread") });
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    const composer = {
      ...props,
      activeThread: thread,
      activePendingProgress: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        customAnswer: "answer",
        activeQuestion: { id: "q1", options: [], allowCustomAnswer: true },
      },
    };
    state.composer = composer;
    return renderComposer(composer);
  });
  store().setDraftThreadContext(id, { envMode: "local", sshDestination: null });
  store().setPrompt(id, "hidden prompt");
  await fixture.mount();
  const before = store().getComposerDraft(id);
  await act(() =>
    state.composer?.composerRef.current?.addTerminalContext({
      terminalId: "terminal-1",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "output",
    }),
  );
  expect(store().getComposerDraft(id)?.prompt).toBe(before?.prompt);
  expect(store().getComposerDraft(id)?.terminalContexts).toEqual(before?.terminalContexts);
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Terminal output can't be added to a question answer." }),
  );
});
