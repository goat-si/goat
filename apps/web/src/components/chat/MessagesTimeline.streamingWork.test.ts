import { TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntry,
} from "../../session-logic";
import { makeStreamingWorkTimelineFixture, withStreamedText } from "../../test-fixtures";
import {
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
} from "./MessagesTimeline.logic";

describe("streaming work rows", () => {
  it.each(["reasoning", "proposed_plan"] as const)(
    "keeps every row not holding streaming %s text when it changes",
    (kind) => {
      const source = makeStreamingWorkTimelineFixture(kind);
      const rowsInput = (timelineEntries: ReadonlyArray<TimelineEntry>) => ({
        timelineEntries,
        latestRun: {
          runId: source.runId,
          status: "running" as const,
          startedAt: source.time(5),
          completedAt: null,
        },
        runningRunId: source.runId,
        isWorking: true,
        activeTurnStartedAt: source.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: true,
      });
      let timelineInput = {
        visibleTurnItems: withStreamedText(
          source.visibleTurnItems,
          source.streamingItemId,
          "Let",
          source.time(20),
        ),
        optimisticMessages: [],
      };
      let timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
      let projection = deriveMessagesTimelineRowsWithState(rowsInput(timeline.entries));
      for (const [step, text] of ["Let me", "Let me check the tests"].entries()) {
        timelineInput = {
          visibleTurnItems: withStreamedText(
            timelineInput.visibleTurnItems,
            source.streamingItemId,
            text,
            source.time(21 + step),
          ),
          optimisticMessages: [],
        };
        const previous = projection;
        timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
        projection = deriveMessagesTimelineRowsWithState(rowsInput(timeline.entries), previous);
        expect(projection.rows).toEqual(
          deriveMessagesTimelineRows(
            rowsInput(deriveTimelineEntriesFromVisibleTurnItems(timelineInput)),
          ),
        );
        expect(projection.rows).toHaveLength(previous.rows.length);
        for (const [index, row] of previous.rows.entries()) {
          const holdsItem =
            row.id === source.streamingItemId ||
            ((row.kind === "work" || row.kind === "work-live") &&
              row.groupedEntries.some((entry) => entry.id === source.streamingItemId));
          if (!holdsItem) expect(projection.rows[index]).toBe(row);
        }
      }
    },
  );

  it.each(["reasoning", "proposed_plan"] as const)(
    "matches a full derivation when streaming %s text turns blank or completes",
    (kind) => {
      const source = makeStreamingWorkTimelineFixture(kind);
      const rowsInput = (timelineEntries: ReadonlyArray<TimelineEntry>) => ({
        timelineEntries,
        latestRun: {
          runId: source.runId,
          status: "running" as const,
          startedAt: source.time(5),
          completedAt: null,
        },
        runningRunId: source.runId,
        isWorking: true,
        activeTurnStartedAt: source.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: true,
      });
      let visibleTurnItems = source.visibleTurnItems;
      let timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState({
        visibleTurnItems,
        optimisticMessages: [],
      });
      let projection = deriveMessagesTimelineRowsWithState(rowsInput(timeline.entries));
      const steps = [
        ...["Let", " ", "Let me"].map(
          (text, step) => (rows: typeof visibleTurnItems) =>
            withStreamedText(rows, source.streamingItemId, text, source.time(20 + step)),
        ),
        (rows: typeof visibleTurnItems) =>
          rows.map((row) =>
            row.item.id === source.streamingItemId &&
            (row.item.type === "reasoning" || row.item.type === "proposed_plan")
              ? {
                  ...row,
                  item: {
                    ...row.item,
                    status: "completed" as const,
                    streaming: false,
                    completedAt: DateTime.makeUnsafe(source.time(30)),
                    updatedAt: DateTime.makeUnsafe(source.time(30)),
                  },
                }
              : row,
          ),
      ];
      for (const step of steps) {
        visibleTurnItems = step(visibleTurnItems);
        const timelineInput = { visibleTurnItems, optimisticMessages: [] };
        timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
        expect(timeline.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(timelineInput));
        projection = deriveMessagesTimelineRowsWithState(rowsInput(timeline.entries), projection);
        expect(projection.rows).toEqual(
          deriveMessagesTimelineRows(
            rowsInput(deriveTimelineEntriesFromVisibleTurnItems(timelineInput)),
          ),
        );
      }
    },
  );

  it.each([
    "expanded live group",
    "expanded live group followed by a hidden tool",
    "thinking superseded by a running tool",
    "settled turn",
  ] as const)("matches a full derivation when streaming thinking sits in a %s", (scenario) => {
    const source = makeStreamingWorkTimelineFixture("reasoning");
    const running = scenario !== "settled turn";
    const hiddenTool = scenario === "expanded live group followed by a hidden tool";
    const rowsInput = (
      timelineEntries: ReadonlyArray<TimelineEntry>,
      expandedWorkGroupIds?: ReadonlySet<string>,
    ) => ({
      timelineEntries,
      latestRun: {
        runId: source.runId,
        status: running ? ("running" as const) : ("completed" as const),
        startedAt: source.time(5),
        completedAt: running ? null : source.time(40),
      },
      runningRunId: running ? source.runId : null,
      isWorking: running,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaries: [],
      supportsConversationRollback: true,
      ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
      ...(running ? {} : { expandedRunIds: new Set([source.runId]) }),
      ...(hiddenTool ? { toolCallVisibility: "hideAll" as const } : {}),
    });
    const tool = source.visibleTurnItems.find((row) => row.item.id === "live-work")!;
    const laterTool = (status: "running" | "completed") => ({
      ...tool,
      position: source.visibleTurnItems.length,
      sourceItemId: TurnItemId.make("live-later-tool"),
      item: {
        ...tool.item,
        id: TurnItemId.make("live-later-tool"),
        ordinal: 8,
        status,
        ...(status === "running" ? { completedAt: null } : {}),
      },
    });
    let visibleTurnItems =
      scenario === "thinking superseded by a running tool" || hiddenTool
        ? [...source.visibleTurnItems, laterTool(hiddenTool ? "completed" : "running")]
        : // Alone in a settled group, the thought's text becomes the group summary.
          source.visibleTurnItems.filter((row) => running || row !== tool);
    visibleTurnItems = withStreamedText(
      visibleTurnItems,
      source.streamingItemId,
      "Let",
      source.time(20),
    );
    let timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState({
      visibleTurnItems,
      optimisticMessages: [],
    });
    const liveRow = deriveMessagesTimelineRows(rowsInput(timeline.entries)).find(
      (row) => row.kind === "work-live",
    );
    const expanded =
      scenario.startsWith("expanded live group") && liveRow?.kind === "work-live"
        ? new Set([liveRow.groupId])
        : undefined;
    let projection = deriveMessagesTimelineRowsWithState(rowsInput(timeline.entries, expanded));
    for (const [step, text] of ["Let me", "Let me check the tests"].entries()) {
      visibleTurnItems = withStreamedText(
        visibleTurnItems,
        source.streamingItemId,
        text,
        source.time(21 + step),
      );
      const timelineInput = { visibleTurnItems, optimisticMessages: [] };
      const previous = projection;
      timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
      projection = deriveMessagesTimelineRowsWithState(
        rowsInput(timeline.entries, expanded),
        previous,
      );
      expect(projection.rows).toEqual(
        deriveMessagesTimelineRows(
          rowsInput(deriveTimelineEntriesFromVisibleTurnItems(timelineInput), expanded),
        ),
      );
      if (!running) continue;
      for (const [index, row] of previous.rows.entries()) {
        const holdsItem =
          (row.kind === "work" || row.kind === "work-live") &&
          row.groupedEntries.some((entry) => entry.id === source.streamingItemId);
        if (!holdsItem) expect(projection.rows[index]).toBe(row);
      }
    }
  });
});
