import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import { field, text } from "../unknownField.ts";
import {
  initialWorkflowAgentTranscriptCursor,
  readWorkflowAgentTranscript,
} from "../workflowAgentTranscript.ts";
import { textFromClaudeContent } from "./ClaudeGoalProjection.ts";
import { findClaudeSubagentTranscriptDir } from "./ClaudeSubagentEffort.ts";
import { isClaudeRootTurnFrame } from "./ClaudeToolFrames.ts";
import {
  isClaudeTranscriptConversationLine,
  isClaudeTranscriptTurnEnd,
} from "./claudeTranscriptLines.ts";

const CLAUDE_FORKED_SKILL_TRANSCRIPT_POLL = "1 second";

type ForkedSkillSubagent = {
  readonly task: { readonly status: string };
  lastAssistantText: string | null;
  lastAssistantMessageId: string | null;
};

// A `context: fork` skill's task_started names no tool call; its frames use this parent id instead.
export function claudeForkedSkillToolUseId(
  message: Extract<SDKMessage, { readonly type: "system"; readonly subtype: "task_started" }>,
): string | undefined {
  const skill = message.description.trim();
  const spawnDepth = Reflect.get(message, "spawn_depth");
  const depth = typeof spawnDepth === "number" ? spawnDepth : 1;
  return message.tool_use_id === undefined &&
    message.task_type === "local_agent" &&
    depth <= 1 &&
    skill.length > 1 &&
    skill.startsWith("/")
    ? `forked-command-${skill.slice(1)}`
    : undefined;
}

export function makeClaudeForkedSkillController<S extends ForkedSkillSubagent>(deps: {
  readonly configDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sessionScope: Scope.Scope;
  readonly flushMs: number;
  readonly subagentsByTaskId: Ref.Ref<Map<string, S>>;
  readonly taskIdsByToolUseId: Ref.Ref<Map<string, string>>;
  readonly projectLine: (subagent: S, line: unknown) => Effect.Effect<boolean>;
}) {
  const getSubagent = (taskId: string) =>
    Ref.get(deps.subagentsByTaskId).pipe(Effect.map((current) => current.get(taskId)));
  // A forked skill's frames arrive only after its task_notification; hold that until they are in.
  const toolUseIdsByTaskId = new Map<string, string>();
  const heldNotifications = new Map<string, SDKMessage>();
  // The stream withholds a fork's frames until it ends, so its transcript is shown while it runs.
  // Frames whose uuid the transcript already showed are skipped when they arrive.
  const transcripts = new Map<
    string,
    {
      readonly fiber: Fiber.Fiber<void>;
      readonly shownUuids: Set<string>;
      readonly finish: Deferred.Deferred<void>;
    }
  >();

  const followTranscript = Effect.fnUntraced(function* (
    nativeSessionId: string,
    taskId: string,
    shownUuids: Set<string>,
    finish: Deferred.Deferred<void>,
  ) {
    let located: Effect.Success<ReturnType<typeof findClaudeSubagentTranscriptDir>>;
    let cursor = initialWorkflowAgentTranscriptCursor;
    let turnEnded = false;
    const drain = Effect.fnUntraced(function* () {
      if (located === undefined) return;
      const { transcriptDir, configDir } = located;
      for (let drained = false; !drained;) {
        const read = yield* readWorkflowAgentTranscript({
          transcriptDir,
          agentId: taskId,
          cursor,
          configDir,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, deps.fileSystem),
          Effect.provideService(Path.Path, deps.path),
          Effect.option,
        );
        if (Option.isNone(read)) break;
        const advanced = read.value.cursor.offset !== cursor.offset;
        cursor = read.value.cursor;
        // Stopping mid-line would leave a shown line unmarked and repeat it from the stream.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            for (const line of read.value.lines) {
              const subagent = yield* getSubagent(taskId);
              const uuid = text(field(line, "uuid"));
              if (subagent === undefined || uuid === undefined || shownUuids.has(uuid)) {
                continue;
              }
              if (
                (yield* deps.projectLine(subagent, line)) &&
                isClaudeTranscriptConversationLine(line) &&
                line.type === "assistant"
              ) {
                const messageId = typeof line.message.id === "string" ? line.message.id : null;
                const reply = textFromClaudeContent(line.message.content);
                subagent.lastAssistantText =
                  messageId !== null && messageId === subagent.lastAssistantMessageId
                    ? `${subagent.lastAssistantText ?? ""}\n${reply}`
                    : reply;
                subagent.lastAssistantMessageId = messageId;
              }
              shownUuids.add(uuid);
              turnEnded = isClaudeTranscriptTurnEnd(line);
            }
          }),
        );
        drained = !read.value.truncated || !advanced;
      }
    });
    while (true) {
      const finishing = yield* Deferred.await(finish).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: CLAUDE_FORKED_SKILL_TRANSCRIPT_POLL,
          orElse: () => Effect.succeed(false),
        }),
      );
      if ((yield* getSubagent(taskId))?.task.status !== "running") {
        return;
      }
      located ??= yield* findClaudeSubagentTranscriptDir({
        configDir: deps.configDir,
        nativeSessionId,
        taskId,
        fileSystem: deps.fileSystem,
        path: deps.path,
      });
      yield* drain();
      if (!finishing) continue;
      // The fork's report is only in its transcript (the stream never sends it) and can land
      // just after the task_notification.
      if (located !== undefined && !turnEnded) {
        yield* Effect.sleep(deps.flushMs);
        yield* drain();
      }
      return;
    }
  });

  const onTaskStarted = Effect.fnUntraced(function* (
    nativeSessionId: string,
    message: Extract<SDKMessage, { readonly type: "system"; readonly subtype: "task_started" }>,
  ) {
    const toolUseId = claudeForkedSkillToolUseId(message);
    if (toolUseId === undefined) return;
    toolUseIdsByTaskId.set(message.task_id, toolUseId);
    yield* Ref.update(deps.taskIdsByToolUseId, (current) =>
      new Map(current).set(toolUseId, message.task_id),
    );
    const previous = transcripts.get(toolUseId);
    if (previous !== undefined) yield* Fiber.interrupt(previous.fiber);
    const shownUuids = new Set<string>();
    const finish = yield* Deferred.make<void>();
    const fiber = yield* followTranscript(
      nativeSessionId,
      message.task_id,
      shownUuids,
      finish,
    ).pipe(Effect.forkIn(deps.sessionScope));
    transcripts.set(toolUseId, { fiber, shownUuids, finish });
  });

  // A forked skill's summary is only its name; its last reply is the report.
  const resultForTaskNotification = Effect.fnUntraced(function* (
    taskId: string,
    summary: string,
  ): Effect.fn.Return<string | undefined> {
    if (!toolUseIdsByTaskId.delete(taskId)) return summary;
    return (yield* getSubagent(taskId))?.lastAssistantText ?? undefined;
  });

  const routeMessage = Effect.fnUntraced(function* <Q, E, R>(
    input: { readonly query: Q; readonly message: SDKMessage },
    route: (input: {
      readonly query: Q;
      readonly message: SDKMessage;
    }) => Effect.Effect<void, E, R>,
  ) {
    const parentToolUseId = Reflect.get(input.message, "parent_tool_use_id");
    // The fork's frames end where the root turn resumes; a system frame (init) can come between.
    const forkFramesDone =
      input.message.type === "result" ||
      (input.message.type !== "system" && isClaudeRootTurnFrame(input.message));
    for (const [toolUseId, notification] of heldNotifications) {
      if (!forkFramesDone) break;
      heldNotifications.delete(toolUseId);
      transcripts.delete(toolUseId);
      yield* route({ query: input.query, message: notification });
    }
    if (input.message.type === "system" && input.message.subtype === "task_notification") {
      const toolUseId = toolUseIdsByTaskId.get(input.message.task_id);
      if (toolUseId !== undefined && !heldNotifications.has(toolUseId)) {
        // Read the rest of the transcript, including the report, before the fork can settle.
        const transcript = transcripts.get(toolUseId);
        if (transcript !== undefined) {
          yield* Deferred.succeed(transcript.finish, undefined);
          yield* Fiber.join(transcript.fiber);
        }
        heldNotifications.set(toolUseId, input.message);
        return;
      }
    }
    const uuid = text(field(input.message, "uuid"));
    if (
      typeof parentToolUseId === "string" &&
      uuid !== undefined &&
      transcripts.get(parentToolUseId)?.shownUuids.has(uuid) === true
    ) {
      return;
    }
    yield* route(input);
  });

  return { onTaskStarted, resultForTaskNotification, routeMessage };
}
