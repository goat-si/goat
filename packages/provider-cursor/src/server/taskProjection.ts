import type { InteractionUpdate, ToolCall } from "@cursor/sdk";
import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@goat/contracts";
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

interface ExactStepMatch {
  readonly liveIndex: number;
  readonly savedIndex: number;
  readonly length: number;
  readonly previous: ExactStepMatch | undefined;
}

function exactStepMatches(live: ReadonlyArray<string>, saved: ReadonlyArray<string>) {
  const liveTexts = new Set(live);
  // Track the longest ordered chain of exact matches with a frontier bounded by the live steps.
  const best = new Array<ExactStepMatch | undefined>(live.length + 1);
  for (const [savedIndex, part] of saved.entries()) {
    const text = part.trim();
    if (!liveTexts.has(text)) continue;
    let diagonal: ExactStepMatch | undefined;
    for (const [liveIndex, liveText] of live.entries()) {
      const above = best[liveIndex + 1];
      const left = best[liveIndex];
      const existing = (left?.length ?? 0) > (above?.length ?? 0) ? left : above;
      const length = (diagonal?.length ?? 0) + 1;
      best[liveIndex + 1] =
        text === liveText && length > (existing?.length ?? 0)
          ? { liveIndex, savedIndex, length, previous: diagonal }
          : existing;
      diagonal = above;
    }
    if (best.at(-1)?.length === live.length) break;
  }
  const matches: ExactStepMatch[] = [];
  for (let match = best.at(-1); match !== undefined; match = match.previous) {
    matches.push(match);
  }
  return matches.reverse();
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
        ordinal: ++subagent.nextChildOrdinal,
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
  ): ActiveCursorToolCall => ({
    callId: nativeId,
    toolCall,
    target: childTarget(subagent),
    ordinal: ++subagent.nextChildOrdinal,
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
    const unstreamed: string[] = [];
    const prefixes = state.assistantSegments.map((segment) => segment.text.trimStart());
    const exact = exactStepMatches(
      prefixes.map((text) => text.trimEnd()),
      resultParts,
    );
    let nextExactIndex = 0;
    let nextSegmentIndex = 0;
    for (const [savedIndex, part] of resultParts.entries()) {
      const anchor = exact[nextExactIndex];
      if (anchor?.savedIndex === savedIndex) {
        nextExactIndex++;
        nextSegmentIndex = anchor.liveIndex + 1;
        continue;
      }

      const saved = part.trimStart();
      const end = anchor?.liveIndex ?? prefixes.length;
      let index = nextSegmentIndex;
      for (; index < end; index++) {
        const prefix = prefixes[index];
        if (prefix && saved.startsWith(prefix)) break;
      }
      const match = index < end ? state.assistantSegments[index] : undefined;
      if (match === undefined) {
        unstreamed.push(part);
        continue;
      }
      nextSegmentIndex = index + 1;
      match.text = part;
      if (match !== state.assistant.current) yield* emitAssistant(target, match, true);
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
      const active = makeTool(subagent, childToolId(subagent, callId), toolCall, startedAt);
      yield* emitToolArtifacts({ active, completed: true });
    }
    return unstreamed.join("\n");
  });

  return { handleTaskUpdate, completeTaskWork };
}
