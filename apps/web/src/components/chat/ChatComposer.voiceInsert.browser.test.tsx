import { expect, it, vi } from "vite-plus/test";
import { state, setupSshComposer, id, store } from "~/test/sshComposerFixture";
import { act } from "../../../test/render";

vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock(import("./useComposerVoiceController"), async (original) => {
  const real = await original();
  return {
    ...real,
    useChatComposerVoiceController: (
      ...args: Parameters<typeof real.useChatComposerVoiceController>
    ) => ({
      ...real.useChatComposerVoiceController(...args),
      isVoiceActive: true,
    }),
  };
});
import { ChatComposer } from "./ChatComposer";
const renderComposer = ChatComposer.type;

it("rejects typed and pasted text while voice input owns the composer", async () => {
  await using fixture = await setupSshComposer(true);
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    state.composer = props;
    return renderComposer(props);
  });
  await fixture.mount();
  const before = store().getComposerDraft(id)?.prompt;
  await act(async () => {
    expect(state.composer!.composerRef.current!.insertTextAtEnd(" typed")).toBe(false);
    expect(state.composer!.composerRef.current!.pasteTextAtEnd(" pasted")).toBe(false);
  });
  expect(store().getComposerDraft(id)?.prompt).toBe(before);
});
