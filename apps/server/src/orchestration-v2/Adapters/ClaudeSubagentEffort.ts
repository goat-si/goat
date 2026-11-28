import { listClaudeDiscoveryDirectory } from "../../provider/claudeDiscoveryBudget.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { mergeWorkflowAgentMetadata, type WorkflowAgentMetadata } from "../workflowAgentAnswers.ts";
import {
  initialWorkflowAgentTranscriptCursor,
  readWorkflowAgentTranscript,
} from "../workflowAgentTranscript.ts";

const TRANSCRIPT_MAX_READS = 8;
const MAX_PROJECT_PROBES = 128;
const TRANSCRIPT_FLUSH_WINDOW = "500 millis";

export const findClaudeSubagentTranscriptDir = Effect.fn("ClaudeSubagentEffort.findTranscriptDir")(
  function* (input: {
    readonly configDir: string;
    readonly nativeSessionId: string;
    readonly taskId: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const { configDir, fileSystem, path, nativeSessionId, taskId } = input;
    if (
      path.basename(nativeSessionId) !== nativeSessionId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)
    )
      return undefined;
    const projectsDir = path.join(configDir, "projects");
    const projects = yield* listClaudeDiscoveryDirectory(projectsDir, MAX_PROJECT_PROBES);
    for (const project of projects) {
      const transcriptDir = path.join(projectsDir, project, nativeSessionId, "subagents");
      if (
        yield* fileSystem
          .exists(path.join(transcriptDir, `agent-${taskId}.jsonl`))
          .pipe(Effect.orElseSucceed(() => false))
      ) {
        return { transcriptDir, configDir };
      }
    }
    return undefined;
  },
);

export const readClaudeSubagentEffort = Effect.fn("ClaudeSubagentEffort.read")(function* (input: {
  readonly configDir: string;
  readonly nativeSessionId: string;
  readonly taskId: string;
  readonly completed: boolean;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const located = yield* findClaudeSubagentTranscriptDir(input);
  if (located === undefined) return undefined;
  const { transcriptDir, configDir } = located;
  const { taskId } = input;

  let metadata: WorkflowAgentMetadata = {};
  let cursor = initialWorkflowAgentTranscriptCursor;
  let reads = 0;
  const read = Effect.fn("ClaudeSubagentEffort.readTranscript")(function* () {
    while (reads++ < TRANSCRIPT_MAX_READS) {
      const result = yield* readWorkflowAgentTranscript({
        transcriptDir,
        agentId: taskId,
        cursor,
        configDir,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (result === undefined) return false;
      metadata = mergeWorkflowAgentMetadata(result.lines, metadata);
      const advanced = result.cursor.offset !== cursor.offset;
      cursor = result.cursor;
      if (metadata.effort !== undefined || !result.truncated || !advanced) break;
    }
    return true;
  });
  // The first reply may still be flushing when Claude reports completion.
  if (
    (yield* read()) &&
    input.completed &&
    metadata.messageId === undefined &&
    reads < TRANSCRIPT_MAX_READS
  ) {
    yield* Effect.sleep(TRANSCRIPT_FLUSH_WINDOW);
    yield* read();
  }
  return metadata.effort;
});
