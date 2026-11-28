import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { DraftId } from "../composerDraftStore";
import { useGlobalAgentStore } from "../globalAgentStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { useCommandPaletteThreadActions } from "./CommandPaletteThreadActions";

const state = vi.hoisted(() => ({
  thread: null as Thread | null,
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: () => state.thread,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => false,
  readEnvironmentSupportsPromotion: () => false,
  useProjects: () => [],
}));

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock("./goatBot/goatBotThreadFollowMenu", () => ({
  webThreadFollowAvailable: () => true,
  handleWebThreadFollowAction: () => undefined,
}));

function renderActions(thread: Thread) {
  state.thread = thread;
  const result: { current: ReturnType<typeof useCommandPaletteThreadActions> } = { current: [] };
  const capture = (items: ReturnType<typeof useCommandPaletteThreadActions>) => {
    result.current = items;
  };
  function Harness(props: {
    readonly capture: (items: ReturnType<typeof useCommandPaletteThreadActions>) => void;
  }) {
    props.capture(
      useCommandPaletteThreadActions({
        threadRef: { environmentId: thread.environmentId, threadId: thread.id },
        projectCwd: "/workspace",
      }),
    );
    return null;
  }
  return render(<Harness capture={capture} />).then((screen) => Object.assign(screen, { result }));
}

it("filters out bot-follow actions handled elsewhere in the palette", async () => {
  const thread = makeThreadFixture({
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("thread-1"),
    branch: "feat/demo",
  });
  await using screen = await renderActions(thread);
  const values = screen.result.current.map((item) => item.value);
  expect(values).not.toContain("thread-action:bot-follow");
  expect(values).not.toContain("thread-action:bot-stop-following");
  expect(values).toContain("thread-action:new-thread-on-branch");
  expect(values).toContain("thread-action:regenerate-title");
});

it("hides global-agent-restricted thread actions in the palette", async () => {
  const thread = makeThreadFixture({
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("global-agent-thread"),
    branch: "main",
  });
  const previous = useGlobalAgentStore.getState().ref;
  useGlobalAgentStore.setState({
    ref: {
      environmentId: thread.environmentId,
      threadId: thread.id,
      draftId: DraftId.make("global-draft"),
    },
  });
  using _restore = { [Symbol.dispose]: () => useGlobalAgentStore.setState({ ref: previous }) };

  await using screen = await renderActions(thread);
  const values = screen.result.current.map((item) => item.value);
  expect(values).not.toContain("thread-action:regenerate-title");
  expect(values).not.toContain("thread-action:new-thread-on-branch");
  expect(values).not.toContain("thread-action:fork");
  expect(values).not.toContain("thread-action:fork:current");
  expect(values).not.toContain("thread-action:fork:worktree");
});
