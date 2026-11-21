import { id, local, setupSshComposer, state, store } from "~/test/sshComposerFixture";
import { ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/render";
import * as entities from "~/state/entities";
import { THREAD_CONTEXT_DROP_EVENT } from "./threadContextDrag";
vi.mock("../ThreadContextChip", () => ({ ThreadContextChip: () => <span>Thread</span> }));
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
const renderComposer = ChatComposer.type;
async function setupComposer() {
  const fixture = await setupSshComposer(true);
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    state.composer = props;
    return renderComposer(props);
  });
  return fixture;
}

it("attaches a palette thread by its supplied title when no shell is cached", async () => {
  await using fixture = await setupComposer();
  vi.mocked(entities.readThreadShell).mockReturnValue(null);
  await fixture.mount();
  const form = fixture.container.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]');
  expect(form).not.toBeNull();
  await act(() =>
    form!.dispatchEvent(
      new CustomEvent(THREAD_CONTEXT_DROP_EVENT, {
        detail: [
          { environmentId: local, threadId: ThreadId.make("uncached"), title: "Uncached thread" },
        ],
      }),
    ),
  );
  expect(store().getComposerDraft(id)?.threadContexts).toMatchObject([
    { threadId: "uncached", title: "Uncached thread" },
  ]);
});
