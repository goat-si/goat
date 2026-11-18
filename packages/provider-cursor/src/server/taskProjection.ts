import type { InteractionUpdate, ToolCall } from "@cursor/sdk";
import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@goat/contracts";
import { CURSOR_TASK_SAVED_ITEM_PREFIX } from "@goat/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type {
  ActiveCursorSubagent,
  ActiveCursorToolCall,
  ActiveCursorTurn,
  CursorProjectionTarget,
  CursorTaskProjectionState,
} from "./activeTurn.ts";
import { MAX_CURSOR_TASK_TEXT_CHARS } from "./taskTextSnapshots.ts";
import type { makeCursorTurnProjection } from "./turnProjection.ts";

const MAX_LIVE_TASK_TOOLS = 512;
const MAX_LIVE_TASK_TEXT_SEGMENTS = 512;
const SAVED_TASK_ALIGNMENT_WINDOW_SIZE = 512;
// Reserve room for all aligned backfill steps before any one live item.
const TASK_LIVE_ORDINAL_STRIDE = SAVED_TASK_ALIGNMENT_WINDOW_SIZE + 1;

export function makeTaskProjectionState(): CursorTaskProjectionState {
  return {
    tools: new Map(),
    assistantSegments: [],
    assistant: { current: null, nextSegment: 0 },
    reasoning: { current: null, nextSegment: 0 },
    remainingText: MAX_CURSOR_TASK_TEXT_CHARS,
  };
}

function childTarget(subagent: ActiveCursorSubagent): CursorProjectionTarget {
  return {
    threadId: subagent.childThreadId,
    runId: null,
    rootNodeId: subagent.childRootNodeId,
    parentNodeId: subagent.childRootNodeId,
    providerThreadId: null,
    providerTurnId: null,
  };
}

function childToolId(subagent: ActiveCursorSubagent, callId: string): string {
  return `${subagent.callId}:child-tool:${callId}`;
}

interface TaskAssistantMatch {
  readonly liveIndex: number;
  readonly savedIndex: number;
}

function alignTaskAssistantWindow(live: ReadonlyArray<string>, saved: ReadonlyArray<string>) {
  if (live.length === 0 || saved.length === 0) return [];
  const prefixes = live.map((text) => text.trimStart());
  const liveText = prefixes.map((text) => text.trimEnd());
  const savedText = saved.map((text) => text.trimStart());
  // At most 512 × 512 cells. One byte per decision and one live-sized score row.
  const decisions = new Uint8Array(saved.length * live.length);
  const scores = new Array<bigint>(live.length + 1).fill(0n);
  const skipLiveItem = 1;
  const matchStep = 2;
  // Saved-index bits break ties lexicographically after match count and exact-match count.
  const exactWeight = 1n << BigInt(saved.length);
  const matchWeight = exactWeight * BigInt(live.length + 1);
  for (let savedIndex = saved.length - 1; savedIndex >= 0; savedIndex--) {
    const text = savedText[savedIndex] ?? "";
    const trimmed = text.trimEnd();
    const savedWeight = 1n << BigInt(saved.length - 1 - savedIndex);
    let diagonal = 0n;
    for (let liveIndex = live.length - 1; liveIndex >= 0; liveIndex--) {
      const skipSaved = scores[liveIndex] ?? 0n;
      const skipLive = scores[liveIndex + 1] ?? 0n;
      const cell = savedIndex * live.length + liveIndex;
      let best = skipSaved;
      if (skipLive > best) {
        best = skipLive;
        decisions[cell] = skipLiveItem;
      }
      const prefix = prefixes[liveIndex];
      const exact = trimmed === liveText[liveIndex];
      if (exact || (prefix && text.startsWith(prefix))) {
        const matched = diagonal + matchWeight + (exact ? exactWeight : 0n) + savedWeight;
        if (matched >= best) {
          best = matched;
          decisions[cell] = matchStep;
        }
      }
      scores[liveIndex] = best;
      diagonal = skipSaved;
    }
  }

  const matches: TaskAssistantMatch[] = [];
  let liveIndex = 0;
  let savedIndex = 0;
  while (liveIndex < live.length && savedIndex < saved.length) {
    const decision = decisions[savedIndex * live.length + liveIndex];
    if (decision === matchStep) {
      matches.push({ liveIndex, savedIndex });
      liveIndex++;
      savedIndex++;
    } else if (decision === skipLiveItem) {
      liveIndex++;
    } else {
      savedIndex++;
    }
  }
  return matches;
}

function alignTaskAssistantSteps(
  live: ReadonlyArray<string>,
  saved: ReadonlyArray<string>,
): TaskAssistantMatch[] {
  const matches: TaskAssistantMatch[] = [];
  let liveStart = 0;
  for (
    let savedStart = 0;
    savedStart < saved.length && liveStart < live.length;
    savedStart += SAVED_TASK_ALIGNMENT_WINDOW_SIZE
  ) {
    const window = alignTaskAssistantWindow(
      live.slice(liveStart),
      saved.slice(savedStart, savedStart + SAVED_TASK_ALIGNMENT_WINDOW_SIZE),
    );
    for (const match of window) {
      matches.push({
        liveIndex: liveStart + match.liveIndex,
        savedIndex: savedStart + match.savedIndex,
      });
    }
    const last = window.at(-1);
    if (last !== undefined) liveStart += last.liveIndex + 1;
  }
  return matches;
}

export function makeCursorTaskProjection({
  emitAssistant,
  emitReasoning,
  emitToolArtifacts,
}: ReturnType<typeof makeCursorTurnProjection>) {
  const completeText = Effect.fnUntraced(function* (subagent: ActiveCursorSubagent) {
    const { assistant, reasoning } = subagent.projection;
    const target = childTarget(subagent);
    yield* emitAssistant(target, assistant.current, true);
    yield* emitReasoning(target, reasoning.current, true);
    assistant.current = null;
    reasoning.current = null;
  });

  const appendText = Effect.fnUntraced(function* (
    subagent: ActiveCursorSubagent,
    kind: "assistant" | "reasoning",
    text: string,
  ) {
    const state = subagent.projection;
    const stream = state[kind];
    const other = kind === "assistant" ? state.reasoning : state.assistant;
    if (other.current !== null) yield* completeText(subagent);
    const chunk = text.slice(0, state.remainingText);
    if (chunk.length === 0) return;
    if (stream.current === null) {
      if (stream.nextSegment >= MAX_LIVE_TASK_TEXT_SEGMENTS) return;
      stream.current = {
        nativeItemId: `${subagent.childThreadId}:${kind}:${++stream.nextSegment}`,
        startedAt: yield* DateTime.now,
        ordinal: (subagent.nextChildOrdinal += TASK_LIVE_ORDINAL_STRIDE),
        text: "",
      };
      if (kind === "assistant") state.assistantSegments.push(stream.current);
    }
    stream.current.text += chunk;
    state.remainingText -= chunk.length;
    const emit = kind === "assistant" ? emitAssistant : emitReasoning;
    yield* emit(childTarget(subagent), stream.current, false);
  });

  const makeTool = (
    subagent: ActiveCursorSubagent,
    nativeId: string,
    toolCall: ToolCall,
    startedAt: DateTime.Utc,
    ordinal: number,
  ): ActiveCursorToolCall => ({
    callId: nativeId,
    toolCall,
    target: childTarget(subagent),
    ordinal,
    startedAt,
    streamedOutput: "",
  });

  const handleTaskUpdate = Effect.fnUntraced(function* (
    context: ActiveCursorTurn,
    update: Extract<InteractionUpdate, { readonly type: "tool-call-delta" }>,
  ) {
    const subagent = context.subagents.get(update.callId);
    if (subagent === undefined || !isOrchestrationV2WorkActive(subagent.task.status)) return;
    context.turnEnded = false;
    const state = subagent.projection;
    const nested = update.taskUpdate;
    switch (nested.type) {
      case "text-delta":
        return yield* appendText(subagent, "assistant", nested.text);
      case "thinking-delta":
        return yield* appendText(subagent, "reasoning", nested.text);
      case "thinking-completed":
        yield* emitReasoning(childTarget(subagent), state.reasoning.current, true);
        state.reasoning.current = null;
        return;
      case "step-completed":
        return yield* completeText(subagent);
      case "tool-call-started":
      case "partial-tool-call":
      case "tool-call-completed": {
        yield* completeText(subagent);
        const existing = state.tools.get(nested.callId);
        if (
          existing === null ||
          (existing === undefined && state.tools.size >= MAX_LIVE_TASK_TOOLS)
        ) {
          return;
        }
        const completed =
          nested.type === "tool-call-completed" && nested.toolCall.result !== undefined;
        const active =
          existing ??
          makeTool(
            subagent,
            childToolId(subagent, nested.callId),
            nested.toolCall,
            yield* DateTime.now,
            (subagent.nextChildOrdinal += TASK_LIVE_ORDINAL_STRIDE),
          );
        active.toolCall = nested.toolCall;
        state.tools.set(nested.callId, completed ? null : active);
        yield* emitToolArtifacts({ active, completed });
        return;
      }
      default:
        return;
    }
  });

  const completeTaskWork = Effect.fnUntraced(function* (
    subagent: ActiveCursorSubagent,
    savedTools: ReadonlyArray<{ readonly callId: string; readonly toolCall: ToolCall }>,
    status: OrchestrationV2Subagent["status"],
    resultParts: ReadonlyArray<string>,
  ) {
    const state = subagent.projection;
    const target = childTarget(subagent);
    const firstWindowEnd = Math.min(resultParts.length, SAVED_TASK_ALIGNMENT_WINDOW_SIZE);
    const live = state.assistantSegments.map((segment) => segment.text);
    const matches = alignTaskAssistantSteps(live, resultParts);
    const now = yield* DateTime.now;
    const emitSaved = (savedIndex: number, text: string, ordinal: number) =>
      emitAssistant(
        target,
        {
          nativeItemId: `${CURSOR_TASK_SAVED_ITEM_PREFIX}${subagent.childThreadId}:${savedIndex}`,
          text,
          ordinal,
          startedAt: now,
        },
        true,
      );
    let savedIndex = 0;
    for (const match of matches) {
      const segment = state.assistantSegments[match.liveIndex];
      const text = resultParts[match.savedIndex];
      if (segment === undefined || text === undefined) continue;
      const gapEnd = Math.min(match.savedIndex, firstWindowEnd);
      for (; savedIndex < gapEnd; savedIndex++) {
        const part = resultParts[savedIndex];
        if (part !== undefined) {
          yield* emitSaved(savedIndex, part, segment.ordinal - (gapEnd - savedIndex));
        }
      }
      savedIndex = Math.min(match.savedIndex + 1, firstWindowEnd);
      if (segment.text === text) continue;
      segment.text = text;
      if (segment !== state.assistant.current) yield* emitAssistant(target, segment, true);
    }
    yield* completeText(subagent);
    state.assistantSegments.length = 0;

    const savedByCall = new Map(
      savedTools.map(({ callId, toolCall }, index) => [callId || String(index + 1), toolCall]),
    );
    const unfinishedStatus = status === "failed" || status === "cancelled" ? status : "interrupted";
    for (const [callId, active] of state.tools) {
      const saved = savedByCall.get(callId);
      savedByCall.delete(callId);
      if (active === null) continue;
      if (saved !== undefined) active.toolCall = saved;
      yield* emitToolArtifacts({
        active,
        completed: true,
        ...(saved?.result === undefined ? { unfinishedStatus } : {}),
      });
    }
    state.tools.clear();

    const startedAt = subagent.task.startedAt ?? (yield* DateTime.now);
    for (const [callId, toolCall] of savedByCall) {
      const active = makeTool(
        subagent,
        childToolId(subagent, callId),
        toolCall,
        startedAt,
        ++subagent.nextChildOrdinal,
      );
      yield* emitToolArtifacts({ active, completed: true });
    }
    for (; savedIndex < firstWindowEnd; savedIndex++) {
      const part = resultParts[savedIndex];
      if (part !== undefined) yield* emitSaved(savedIndex, part, ++subagent.nextChildOrdinal);
    }
    if (firstWindowEnd < resultParts.length) {
      const matchedSteps = new Set(matches.map((match) => match.savedIndex));
      const overflow: string[] = [];
      for (let index = firstWindowEnd; index < resultParts.length; index++) {
        const part = resultParts[index];
        if (part !== undefined && !matchedSteps.has(index)) overflow.push(part);
      }
      if (overflow.length > 0) {
        yield* emitSaved(firstWindowEnd, overflow.join("\n"), ++subagent.nextChildOrdinal);
      }
    }
  });

  return { handleTaskUpdate, completeTaskWork };
}
