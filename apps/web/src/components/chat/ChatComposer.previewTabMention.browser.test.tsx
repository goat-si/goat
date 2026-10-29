// The fixture registers its module mocks, so it loads before anything those modules feed.
import { id, local, remote, setupSshComposer, state, store } from "~/test/sshComposerFixture";
import { SERVER_BROWSER_AUTOMATION_CLIENT_ID, ThreadId } from "@goat/contracts";
import type { OrchestrationMessageContext } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { previewEnvironment } from "~/state/preview";
import { environmentServerConfigsAtom } from "~/state/server";
import { act } from "../../../test/render";

vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
import { THREAD_CONTEXT_DROP_EVENT } from "./threadContextDrag";
import * as entities from "~/state/entities";
const renderComposer = ChatComposer.type;
// Records the real composer's props; the fixture restores this spy after each test.
async function setupComposer() {
  const fixture = await setupSshComposer(true);
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    state.composer = props;
    return renderComposer(props);
  });
  return fixture;
}

type SentMessage = { readonly text: string; readonly context?: OrchestrationMessageContext };
const sentMessage = () =>
  state.normal.mock.calls
    .map(([request]) => (request as { input?: { message?: SentMessage } }).input?.message)
    .find((message) => message !== undefined);

it("refuses an unverified dropped thread without attaching a transcript", async () => {
  await using fixture = await setupComposer();
  vi.mocked(entities.readThreadShell).mockReturnValue({ title: "Remote" } as never);
  await fixture.mount();
  const form = fixture.container.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]');
  expect(form).not.toBeNull();
  await act(() =>
    form!.dispatchEvent(
      new CustomEvent(THREAD_CONTEXT_DROP_EVENT, {
        detail: [{ environmentId: remote, threadId: ThreadId.make("remote") }],
      }),
    ),
  );
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Can't verify the route to Build" }),
  );
  const draft = store().getComposerDraft(id);
  expect(draft?.threadContexts ?? []).toEqual([]);
  expect(draft?.files ?? []).toEqual([]);
});

it("sends a server browser tab picked from the @ list as one exact preview-tab record", async () => {
  await using fixture = await setupComposer();
  const { mount, container, primary } = fixture;
  const config = primary.serverConfig!;
  config.providers = config.providers.map((provider) => ({ ...provider, installed: true }));
  store().setDraftThreadContext(id, { envMode: "local", sshDestination: null });
  store().setPrompt(id, "Check @");
  const listAtom = previewEnvironment.list({
    environmentId: local,
    input: { threadId: ThreadId.make("A") },
  });
  state.queryData = (atom) => {
    return atom === listAtom
      ? {
          sessions: [
            {
              threadId: "A",
              tabId: "tab-7",
              navStatus: { _tag: "Success", title: "Orders", url: "https://example.test/orders" },
              canGoBack: false,
              canGoForward: false,
              runtime: "server",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          serverEpoch: "epoch",
          revision: 1,
        }
      : null;
  };
  // Inline context support keeps the record on the wire instead of folding it into the text.
  const registry = state.registry!;
  const fallback = vi.mocked(registry.get).getMockImplementation()!;
  vi.mocked(registry.get).mockImplementation(((atom: unknown) =>
    atom === environmentServerConfigsAtom
      ? new Map([[local, { environment: { capabilities: { inlineMessageContext: true } } }]])
      : fallback(atom as never)) as typeof registry.get);
  state.normal.mockResolvedValue({ _tag: "Success", value: {} });

  await mount();
  await act(async () => state.composer!.composerRef.current!.focusAtEnd());
  const row = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-composer-item-id="preview-tab:tab-7"]',
    );
    expect(element?.textContent).toContain("Orders");
    return element!;
  });
  await act(async () => row.click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );

  const message = await vi.waitFor(() => {
    const sent = sentMessage();
    expect(sent).toBeDefined();
    return sent!;
  });
  const records = message.context?.records ?? [];
  expect(records).toEqual([
    expect.objectContaining({
      kind: "preview-tab",
      environmentId: local,
      browserInstanceId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
      tabId: "tab-7",
    }),
  ]);
  expect(message.text).toContain(formatInlineContextReference(records[0]!));
});
