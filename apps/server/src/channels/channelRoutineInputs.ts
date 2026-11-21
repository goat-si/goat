/**
 * Routine inputs: the scheduler's link row (scheduled_task_channel_inputs) marks them by input id,
 * so routine-ness never depends on who delivered the input. @module channelRoutineInputs
 */
import type { ChannelInputId, ChannelReceptionResult, ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ChannelLedgerError } from "./channelLedgerError.ts";

/** Idempotency keys only the scheduler may use; a person cannot pre-claim a firing's input. */
export const ROUTINE_KEY_PREFIX = "routine:";

export const ROUTINE_COPY = {
  cannotStartWork:
    "This check-in can only report. Ask me directly when you want work started or changed.",
  noUpdate: "No update.",
} as const;

export const makeRoutineInputs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const isRoutineInput = (inputId: ChannelInputId) =>
    sql<{ readonly one: number }>`
      SELECT 1 AS one FROM scheduled_task_channel_inputs WHERE input_id = ${inputId} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        (cause) =>
          new ChannelLedgerError({ reason: "persistence", detail: "read routine link", cause }),
      ),
    );
  const workProject = (inputId: ChannelInputId) =>
    sql<{ readonly project_id: ProjectId }>`
      SELECT json_extract(payload_json, '$.projectId') AS project_id
      FROM scheduled_task_channel_inputs WHERE input_id = ${inputId}
        AND json_extract(payload_json, '$.routineMode') = 'work'`.pipe(
      Effect.map((rows) => rows[0]?.project_id),
      Effect.mapError(
        (cause) =>
          new ChannelLedgerError({
            reason: "persistence",
            detail: "read work trigger project",
            cause,
          }),
      ),
    );
  return { isRoutineInput, workProject };
});

/**
 * A routine input only answers: it reads and replies, or ends with no_update. Anything that
 * would start, stop or steer work, answer a question, or keep a note becomes a plain reply, so an
 * unattended firing can never need an approval. no_update is a routine's word only.
 */
export const routineDecision = (
  decision: ChannelReceptionResult,
  routine: boolean,
  workProject?: ProjectId,
  prompt?: string,
): ChannelReceptionResult => {
  if (!routine)
    return decision.action.type === "no_update"
      ? { ...decision, action: { type: "report_only" } }
      : decision;
  if (workProject !== undefined) {
    const { replyText, action } = decision;
    return action.type === "create_task"
      ? {
          replyText,
          action: {
            type: "create_task",
            projectId: workProject,
            title: action.title,
            instruction: prompt ?? "",
          },
        }
      : {
          replyText:
            action.type === "report_only" ? replyText : "This trigger can only start new work.",
          action: { type: "report_only" },
        };
  }
  const { remember: _remember, rememberQuote: _quote, ...answer } = decision;
  switch (answer.action.type) {
    case "report_only":
    case "status":
    case "no_update":
      return answer;
    default:
      return { replyText: ROUTINE_COPY.cannotStartWork, action: { type: "report_only" } };
  }
};

export const routinePromptFields = (routine: boolean, workProject: ProjectId | undefined) =>
  workProject !== undefined ? { routineWork: true as const } : routine ? { routine: true } : {};
