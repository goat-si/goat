import { id, local, setupSshComposer, state, store } from "~/test/sshComposerFixture";
import { ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { threadContextRecord } from "../../lib/composerContextRecords";

vi.mock("../ThreadContextChip", () => ({ ThreadContextChip: () => <span>Thread</span> }));
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
const renderComposer = ChatComposer.type;

it("enables sending a draft containing only a thread mention", async () => {
  await using fixture = await setupSshComposer(true);
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    state.composer = props;
    return renderComposer(props);
  });
  fixture.primary.serverConfig!.providers = fixture.primary.serverConfig!.providers.map(
    (provider) => ({ ...provider, installed: true }),
  );
  store().setDraftThreadContext(id, { envMode: "local", sshDestination: null });
  store().setPrompt(id, "");
  store().setThreadContexts(id, [
    threadContextRecord({ environmentId: local, threadId: ThreadId.make("other") }, "Other"),
  ]);
  await fixture.mount();
  const button = fixture.container.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
});
