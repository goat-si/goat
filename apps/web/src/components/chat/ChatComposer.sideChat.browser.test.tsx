import { id, setupSshComposer, state, store } from "~/test/sshComposerFixture";
import { RuntimeRequestId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
const renderComposer = ChatComposer.type;

it.each([
  { text: "/side question", label: "Submit" },
  { text: "ordinary", label: "Steer" },
])("shows $label for $text while an approval is pending", async ({ text, label }) => {
  await using fixture = await setupSshComposer(true);
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    const approval = {
      requestId: RuntimeRequestId.make("approval"),
      requestKind: "command" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      responseCapability: "live" as const,
    };
    const composer = {
      ...props,
      phase: "running" as const,
      canSteer: true,
      sideChatAvailable: true,
      pendingApprovals: [approval],
      activePendingApproval: approval,
    };
    state.composer = composer;
    return renderComposer(composer);
  });
  fixture.primary.serverConfig!.providers = fixture.primary.serverConfig!.providers.map(
    (provider) => ({ ...provider, installed: true }),
  );
  store().setDraftThreadContext(id, { envMode: "local", sshDestination: null });
  store().setPrompt(id, text);
  await fixture.mount();
  const button = fixture.container.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(button?.getAttribute("aria-label")).toContain(label);
});
