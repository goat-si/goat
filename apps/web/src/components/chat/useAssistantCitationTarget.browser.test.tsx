import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@goat/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  timelineTurnFoldRunIdsByEntryId,
} from "./MessagesTimeline.logic";
import { useAssistantCitationTarget, type CitationHistoryPage } from "./useAssistantCitationTarget";
import type { AssistantCitationRequest } from "./AssistantCitationSource";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));

const at = "2026-01-01T00:00:00Z";
function message(
  id: string,
  role: "user" | "assistant",
  runId: RunId | null = null,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId,
      createdAt: at,
      updatedAt: at,
      streaming: false,
    },
  };
}
const request: AssistantCitationRequest = {
  key: "citation-1",
  citation: {
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("source"),
    text: "source",
    start: 0,
    end: 6,
    prefix: "",
    suffix: "",
  },
};
const foldInput = {
  latestRun: null,
  runningRunId: null,
  isWorking: false,
  runlessWorkActive: false,
};
let result: ReturnType<typeof useAssistantCitationTarget>;
let root: Root;
let viewport: HTMLDivElement;
const listRef = { current: {} as LegendListRef };
const manualNavigation = vi.fn();
const expanded = vi.fn();
function Harness({
  entries,
  history = null,
  hideRows = false,
}: {
  entries: readonly TimelineEntry[];
  history?: CitationHistoryPage | null;
  hideRows?: boolean;
}) {
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(new Set());
  const onExpandTurn = (runId: RunId) => {
    expanded(runId);
    setExpandedRunIds((previous) =>
      previous.has(runId) ? previous : new Set(previous).add(runId),
    );
  };
  const rows = hideRows
    ? []
    : deriveMessagesTimelineRows({
        ...foldInput,
        timelineEntries: entries,
        expandedRunIds,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
  const navigation = useAssistantCitationTarget({
    request,
    entries,
    rows,
    listRef,
    viewport,
    historyLoading: false,
    loadEarlier: history,
    getTurnFoldRunId: (entryId) =>
      timelineTurnFoldRunIdsByEntryId({ ...foldInput, timelineEntries: entries }).get(entryId),
    onExpandTurn,
    onManualNavigation: manualNavigation,
  });
  useLayoutEffect(() => {
    result = navigation;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = document.createElement("div");
  toast.mockClear();
  expanded.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
async function mount(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root = createRoot(document.createElement("div"));
    root.render(<Harness {...props} />);
  });
  await act(async () => result.onListLoad());
}

it("loads older pages until the cited response mounts and completes positioning", async () => {
  const load = vi.fn();
  await mount({
    entries: [message("newest", "assistant")],
    history: { loading: false, cursor: "page-1", onLoadEarlier: load },
  });
  expect(load).toHaveBeenCalledTimes(1);
  expect(toast).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <Harness
        entries={[message("newest", "assistant")]}
        history={{ loading: true, cursor: "page-1", onLoadEarlier: load }}
      />,
    ),
  );
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(
      <Harness
        entries={[message("middle", "assistant"), message("newest", "assistant")]}
        history={{ loading: false, cursor: "page-2", onLoadEarlier: load }}
      />,
    ),
  );
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () =>
    root.render(
      <Harness entries={[message("source", "assistant"), message("newest", "assistant")]} />,
    ),
  );
  expect(result.target?.citation.messageId).toBe("source");
  expect(result.alwaysRender?.keys).toContain("source");
  await act(async () => result.target?.onComplete());
  expect(result.positioning).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it("reports unavailable only after older history is exhausted", async () => {
  const load = vi.fn();
  await mount({ entries: [], history: { loading: false, cursor: "page-1", onLoadEarlier: load } });
  expect(load).toHaveBeenCalledOnce();
  expect(result.positioning).toBe(true);
  expect(toast).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness entries={[message("other", "assistant")]} />));
  expect(result.positioning).toBe(false);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "The cited response is unavailable" }),
  );
});

it("unfolds an imported runless turn and finishes citation positioning", async () => {
  await mount({
    entries: [
      message("prompt", "user"),
      message("source", "assistant"),
      message("answer", "assistant"),
    ],
  });
  expect(expanded).toHaveBeenCalledWith(RunId.make("runless:prompt"));
  expect(result.target?.citation.messageId).toBe("source");
  await act(async () => result.target?.onComplete());
  expect(result.positioning).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it("ends positioning when a hidden source has no turn fold owner", async () => {
  await mount({ entries: [message("source", "assistant")], hideRows: true });
  expect(expanded).not.toHaveBeenCalled();
  expect(result.positioning).toBe(false);
  expect(result.target).toBeNull();
  expect(toast).toHaveBeenCalledOnce();
});

it("allows manual navigation to cancel citation loading", async () => {
  await mount({
    entries: [],
    history: { loading: true, cursor: "page-1", onLoadEarlier: vi.fn() },
  });
  await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 })));
  expect(result.positioning).toBe(false);
  expect(toast).not.toHaveBeenCalled();
});

it("ends positioning when a history request fails", async () => {
  const load = vi.fn();
  await mount({ entries: [], history: { loading: false, cursor: "page-1", onLoadEarlier: load } });
  await act(async () =>
    root.render(
      <Harness
        entries={[]}
        history={{ loading: false, cursor: "page-1", error: "offline", onLoadEarlier: load }}
      />,
    ),
  );
  expect(load).toHaveBeenCalledOnce();
  expect(result.positioning).toBe(false);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Could not load the cited response" }),
  );
});

it("ends positioning if a settled history request does not advance its cursor", async () => {
  const load = vi.fn();
  await mount({ entries: [], history: { loading: false, cursor: "page-1", onLoadEarlier: load } });
  await act(async () =>
    root.render(
      <Harness entries={[]} history={{ loading: true, cursor: "page-1", onLoadEarlier: load }} />,
    ),
  );
  await act(async () =>
    root.render(
      <Harness entries={[]} history={{ loading: false, cursor: "page-1", onLoadEarlier: load }} />,
    ),
  );
  expect(load).toHaveBeenCalledOnce();
  expect(result.positioning).toBe(false);
  expect(toast).toHaveBeenCalledOnce();
});
